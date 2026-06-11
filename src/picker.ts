/**
 * Pick detector — Build 5 of the watch-daemon scope.
 *
 * After the daemon publishes N variants for an inbound BriefEvent, it records
 * a `PublishRecord` in a local JSON sidecar. A background loop periodically
 * queries each variant's destination for pick signals (typically: did a human
 * edit this after publish?). The first variant to show a human modification
 * is treated as the operator's pick — the daemon emits a Langfuse score
 * against the originating generation trace so the eval loop sees which
 * variant won.
 *
 * Lifecycle:
 *
 *   handleEvent() → ... → publish variants → recordPublish(sidecar, entry)
 *
 *   watchAll() spawns picker loop:
 *     every N seconds:
 *       for each unpicked entry in sidecar:
 *         for each variant fileId:
 *           detectPick(adapter, fileId, publishedAt)
 *           if picked: mark + emit langfuse score, break
 *           if notFound for ALL variants: prune
 *
 * Sidecar is read-modify-write on disk per operation. Daemon is single-process
 * so no locking required.
 *
 * Langfuse emission is graceful: when LANGFUSE_* env vars are unset the
 * emitter is a no-op (same pattern as the rest of the pipeline).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type {
  DestinationAdapter,
  DetectPickResult,
} from './destination/index.js'

// ─── Sidecar shapes ─────────────────────────────────────────────────────────

export interface PublishedVariant {
  variantId: string
  model: string
  /** Destination-specific identifier (Google Doc id, ticket id, …). */
  fileId: string
  /** Composite grader score at publish time. */
  score: number
}

export interface PublishRecord {
  /** Run id from generate() — used as Langfuse trace id. */
  runId: string
  sourceId: string
  sourceName: string
  /** The destination key from brand-kit.destinations.entries. */
  destinationKey: string
  /** ISO timestamp of when the daemon completed publish. */
  publishedAtIso: string
  variants: PublishedVariant[]
  /** Set once a pick is detected. */
  picked?: {
    variantId: string
    fileId: string
    detectedAtIso: string
    modifiedBy?: string
  }
}

export interface Sidecar {
  publishes: PublishRecord[]
}

export function defaultSidecarPath(name: string): string {
  return join(homedir(), '.config', 'copy-pipeline', `${name}.publishes.json`)
}

export async function readSidecar(path: string): Promise<Sidecar> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Sidecar
    return { publishes: parsed.publishes ?? [] }
  } catch {
    return { publishes: [] }
  }
}

export async function writeSidecar(
  path: string,
  sidecar: Sidecar,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(sidecar, null, 2), 'utf8')
}

export async function recordPublish(
  path: string,
  record: PublishRecord,
): Promise<void> {
  const cur = await readSidecar(path)
  cur.publishes.push(record)
  await writeSidecar(path, cur)
}

// ─── Annotation queue routing (graceful no-op when env unset) ──────────────

/**
 * Route a trace into a Langfuse annotation queue. POSTs to
 * /api/public/annotation-queues/{queueId}/items. Graceful: skips silently
 * when LANGFUSE_* env vars aren't set, and returns false (with a log line)
 * on any HTTP / network failure rather than throwing — annotation routing
 * is best-effort, never load-bearing for the publish.
 */
export async function routeToAnnotationQueue(args: {
  queueId: string
  traceId: string
  log?: PickerLogger
}): Promise<boolean> {
  const log: PickerLogger = args.log ?? (() => undefined)
  const pk = process.env['LANGFUSE_PUBLIC_KEY']
  const sk = process.env['LANGFUSE_SECRET_KEY']
  const base = process.env['LANGFUSE_BASE_URL'] ?? 'https://cloud.langfuse.com'
  if (!pk || !sk) return false
  try {
    const res = await fetch(
      `${base}/api/public/annotation-queues/${encodeURIComponent(args.queueId)}/items`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          objectId: args.traceId,
          objectType: 'TRACE',
        }),
      },
    )
    if (!res.ok) {
      const body = await res.text()
      log('warn', `annotation queue routing failed`, {
        status: res.status,
        body: body.slice(0, 200),
      })
      return false
    }
    return true
  } catch (err) {
    log('warn', `annotation queue routing threw`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

// ─── Langfuse emitter (graceful no-op when env unset) ──────────────────────

export interface PickScoreEmitter {
  /** Emit one score against a Langfuse trace. */
  emit(args: {
    traceId: string
    name: string
    value: number
    comment?: string
  }): Promise<void>
  /** Flush any buffered events. Called before daemon exit. */
  flush?(): Promise<void>
}

const noopEmitter: PickScoreEmitter = {
  async emit() {
    // no-op
  },
}

/** Build a Langfuse emitter from env vars. Returns no-op when keys unset. */
export async function buildDefaultEmitter(): Promise<PickScoreEmitter> {
  const pk = process.env['LANGFUSE_PUBLIC_KEY']
  const sk = process.env['LANGFUSE_SECRET_KEY']
  const base = process.env['LANGFUSE_BASE_URL']
  if (!pk || !sk) return noopEmitter
  try {
    const { Langfuse } = await import('langfuse')
    const lf = new Langfuse({
      publicKey: pk,
      secretKey: sk,
      ...(base ? { baseUrl: base } : {}),
    })
    return {
      async emit({ traceId, name, value, comment }) {
        lf.score({
          traceId,
          name,
          value,
          ...(comment ? { comment } : {}),
        })
      },
      async flush() {
        await lf.flushAsync()
      },
    }
  } catch {
    // Langfuse package missing or constructor threw — fall back to no-op so
    // the daemon doesn't crash just because tracing is misconfigured.
    return noopEmitter
  }
}

// ─── Picker loop ────────────────────────────────────────────────────────────

export type PickerLogLevel = 'info' | 'warn' | 'error'
export type PickerLogger = (
  level: PickerLogLevel,
  msg: string,
  meta?: Record<string, unknown>,
) => void

export interface PickerLoopOptions {
  sidecarPath: string
  /** How often to poll Drive for pick signals (ms). */
  pollIntervalMs: number
  /** Destination key → adapter + adapter config — daemon resolves these from
   *  brand-kit before spawning the loop. */
  destinations: Map<
    string,
    { adapter: DestinationAdapter; config: Record<string, unknown> }
  >
  emitter: PickScoreEmitter
  signal?: AbortSignal
  /** Override sleep for tests. */
  sleep?: (ms: number) => Promise<void>
  log?: PickerLogger
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

export async function pickerLoop(opts: PickerLoopOptions): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep
  const log: PickerLogger = opts.log ?? (() => undefined)

  while (!opts.signal?.aborted) {
    await processOneIteration({
      sidecarPath: opts.sidecarPath,
      destinations: opts.destinations,
      emitter: opts.emitter,
      log,
    })
    if (opts.signal?.aborted) break
    await sleep(opts.pollIntervalMs)
  }
}

export async function processOneIteration(args: {
  sidecarPath: string
  destinations: Map<
    string,
    { adapter: DestinationAdapter; config: Record<string, unknown> }
  >
  emitter: PickScoreEmitter
  log: PickerLogger
}): Promise<void> {
  const sidecar = await readSidecar(args.sidecarPath)
  let mutated = false

  for (const record of sidecar.publishes) {
    if (record.picked) continue
    const destination = args.destinations.get(record.destinationKey)
    if (!destination?.adapter.detectPick) continue

    let allMissing = true
    for (const variant of record.variants) {
      let res: DetectPickResult
      try {
        res = await destination.adapter.detectPick({
          fileId: variant.fileId,
          config: destination.config,
          publishedAtIso: record.publishedAtIso,
        })
      } catch (err) {
        args.log('warn', `detectPick threw for ${variant.fileId}`, {
          error: err instanceof Error ? err.message : String(err),
        })
        allMissing = false
        continue
      }
      if (!res.notFound) allMissing = false
      if (res.picked) {
        record.picked = {
          variantId: variant.variantId,
          fileId: variant.fileId,
          detectedAtIso: new Date().toISOString(),
          ...(res.modifiedBy ? { modifiedBy: res.modifiedBy } : {}),
        }
        await emitPickScores({
          record,
          winningVariantId: variant.variantId,
          emitter: args.emitter,
          log: args.log,
        })
        mutated = true
        break
      }
    }

    if (!record.picked && allMissing) {
      // Every variant is gone — prune the entry. Mark picked=unknown so we
      // don't keep checking. No score emitted; we can't tell which won.
      record.picked = {
        variantId: '<all-files-missing>',
        fileId: '<unknown>',
        detectedAtIso: new Date().toISOString(),
      }
      args.log('warn', `every variant gone for run ${record.runId} — pruning`, {
        sourceName: record.sourceName,
      })
      mutated = true
    }
  }

  if (mutated) await writeSidecar(args.sidecarPath, sidecar)
}

async function emitPickScores(args: {
  record: PublishRecord
  winningVariantId: string
  emitter: PickScoreEmitter
  log: PickerLogger
}): Promise<void> {
  const { record, winningVariantId, emitter, log } = args
  for (const v of record.variants) {
    const value = v.variantId === winningVariantId ? 1 : 0
    try {
      await emitter.emit({
        traceId: record.runId,
        name: 'picked',
        value,
        comment:
          v.variantId === winningVariantId
            ? `picked from ${record.destinationKey} (${record.sourceName})`
            : `not picked (winner: ${winningVariantId})`,
      })
    } catch (err) {
      log('warn', `emitter.emit failed for ${v.variantId}`, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  log('info', `pick detected: ${winningVariantId}`, {
    runId: record.runId,
    sourceName: record.sourceName,
  })
}
