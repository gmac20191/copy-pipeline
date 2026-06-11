/**
 * `watchAll()` — the daemon orchestrator behind `copy-pipeline-watch`.
 *
 * Reads a brand-kit, consumes every configured BriefSource, runs `generate()`
 * per inbound event, and publishes every variant to that source's
 * `reviewed_destination`. On failure, optionally writes a marker to
 * `needs_attention_destination` so the content team can see what broke
 * without tailing logs.
 *
 * The default policy is **every variant goes to /reviewed**. Reviewers pick
 * by reading them in the destination folder — picking is not the daemon's
 * concern. (HITL diff-signal is Build 5; for v1 the destination folder IS
 * the review queue.)
 *
 * Sources run concurrently: each `watch()` AsyncIterable is consumed in its
 * own task; an AbortSignal closes them all together. Per-event processing
 * inside one source is serial (yields are awaited in order) — generate()
 * already fans out across models internally.
 *
 * Filename templating: the daemon pre-resolves per-event placeholders into
 * the destination config before calling `publish()` (because PublishArgs
 * doesn't carry per-event context). Supported placeholders:
 *
 *   {{source_id}}      — BriefEvent.id
 *   {{source_name}}    — metadata.sourcePath (falls back to source_id)
 *   {{variant_index}}  — 0-based index in the run's graded variants
 *   {{variant_model}}  — variant.model with '/' → '_' for filesystem safety
 *   {{score}}          — composite grader score (rounded to 2dp)
 *
 * {{timestamp}} is resolved by the destination itself (already supported by
 * google-drive); the daemon doesn't touch it.
 */

import {
  DESTINATION_REGISTRY,
  type DestinationAdapter,
} from './destination/index.js'
import { generate } from './generate.js'
import {
  INPUT_SOURCE_REGISTRY,
  type BriefEvent,
  type BriefSource,
} from './source/index.js'
import type { BrandKit, GenerationRun } from './types.js'
import {
  buildDefaultEmitter,
  defaultSidecarPath,
  pickerLoop,
  recordPublish,
  routeToAnnotationQueue,
  type PickScoreEmitter,
  type PublishedVariant,
} from './picker.js'

// ─── Logger ─────────────────────────────────────────────────────────────────

export type WatchLogLevel = 'info' | 'warn' | 'error'
export type WatchLogger = (
  level: WatchLogLevel,
  msg: string,
  meta?: Record<string, unknown>,
) => void

const defaultLogger: WatchLogger = (level, msg, meta) => {
  const stamp = new Date().toISOString()
  const tail = meta ? ` ${JSON.stringify(meta)}` : ''

  console[level === 'error' ? 'error' : 'log'](
    `[${stamp}] [${level}] ${msg}${tail}`,
  )
}

// ─── Filename templating ────────────────────────────────────────────────────

export interface FilenameContext {
  sourceId: string
  sourceName: string
  variantIndex: number
  variantModel: string
  score: number
}

export function applyFilenameTemplate(
  template: string,
  ctx: FilenameContext,
): string {
  return template
    .replaceAll('{{source_id}}', ctx.sourceId)
    .replaceAll('{{source_name}}', ctx.sourceName)
    .replaceAll('{{variant_index}}', String(ctx.variantIndex))
    .replaceAll('{{variant_model}}', ctx.variantModel.replaceAll('/', '_'))
    .replaceAll('{{score}}', ctx.score.toFixed(2))
}

function withResolvedFilename(
  config: Record<string, unknown>,
  ctx: FilenameContext,
): Record<string, unknown> {
  const filename = config['filename']
  if (typeof filename !== 'string') return config
  return { ...config, filename: applyFilenameTemplate(filename, ctx) }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export interface WatchAllOptions {
  brandKit: BrandKit
  /** Absolute path passed to BriefSource.watch + relayed to generate(). */
  workspaceRoot: string
  /** Aborts every source's watch loop when fired. */
  signal?: AbortSignal
  /** Override the source registry (tests). Falls back to INPUT_SOURCE_REGISTRY. */
  sourceRegistry?: Map<string, BriefSource>
  /** Override the destination registry (tests). Falls back to DESTINATION_REGISTRY. */
  destinationRegistry?: Map<string, DestinationAdapter>
  /** Override generate() (tests). */
  generate?: typeof generate
  log?: WatchLogger
  /** Override the picker sidecar path. Defaults to
   *  ~/.config/copy-pipeline/<brandKit.name>.publishes.json. */
  sidecarPath?: string
  /** Picker poll interval in ms. Default 30000 (30s). Picks aren't time-
   *  sensitive; longer interval = less Drive quota burn. */
  pickerPollIntervalMs?: number
  /** Override the Langfuse emitter (tests). When omitted the daemon builds
   *  one from LANGFUSE_* env vars; if those are unset, it's a no-op. */
  pickerEmitter?: PickScoreEmitter
  /** Set to true to skip the picker loop entirely (useful for tests, or
   *  when running the daemon as a one-shot generator). */
  disablePicker?: boolean
}

export async function watchAll(opts: WatchAllOptions): Promise<void> {
  const {
    brandKit,
    workspaceRoot,
    signal,
    sourceRegistry = INPUT_SOURCE_REGISTRY,
    destinationRegistry = DESTINATION_REGISTRY,
    generate: generateFn = generate,
    log = defaultLogger,
    sidecarPath = defaultSidecarPath(brandKit.name),
    pickerPollIntervalMs = 30_000,
    pickerEmitter,
    disablePicker = false,
  } = opts

  const sources = brandKit.input_sources?.entries ?? {}
  const names = Object.keys(sources)
  if (names.length === 0) {
    log('warn', 'no input_sources configured in brand-kit; nothing to watch')
    return
  }

  log('info', `starting watch over ${names.length} source(s)`, {
    sources: names,
  })

  // Validate up front so the daemon doesn't crash mid-flight on a typo.
  for (const sourceName of names) {
    const entry = sources[sourceName]!
    if (!sourceRegistry.has(entry.adapter)) {
      throw new Error(
        `input source "${sourceName}" references unregistered adapter "${entry.adapter}"`,
      )
    }
    if (
      !destinationRegistry.has(
        brandKit.destinations?.entries?.[entry.reviewed_destination]?.adapter ??
          '',
      )
    ) {
      const dest = brandKit.destinations?.entries?.[entry.reviewed_destination]
      throw new Error(
        `input source "${sourceName}" reviewed_destination "${entry.reviewed_destination}" ${
          dest
            ? `references unregistered adapter "${dest.adapter}"`
            : 'not found in brand-kit.destinations.entries'
        }`,
      )
    }
    if (entry.needs_attention_destination) {
      const na =
        brandKit.destinations?.entries?.[entry.needs_attention_destination]
      if (!na || !destinationRegistry.has(na.adapter)) {
        throw new Error(
          `input source "${sourceName}" needs_attention_destination "${entry.needs_attention_destination}" ${
            na
              ? `references unregistered adapter "${na.adapter}"`
              : 'not found in brand-kit.destinations.entries'
          }`,
        )
      }
    }
  }

  // Pre-flight every destination referenced by an input source. Adapters that
  // don't implement preflight() skip silently. Failures throw — better to die
  // loudly at boot than at first publish (where SA-on-personal-Drive 403s
  // would silently start filling /needs-attention with marker docs).
  const destinationsToCheck = new Set<string>()
  for (const sourceName of names) {
    const entry = sources[sourceName]!
    destinationsToCheck.add(entry.reviewed_destination)
    if (entry.needs_attention_destination) {
      destinationsToCheck.add(entry.needs_attention_destination)
    }
  }
  for (const destKey of destinationsToCheck) {
    const destEntry = brandKit.destinations!.entries[destKey]!
    const adapter = destinationRegistry.get(destEntry.adapter)!
    if (!adapter.preflight) continue
    const result = await adapter.preflight({
      targetName: destKey,
      config: destEntry.config,
    })
    if (!result.ok) {
      throw new Error(
        `preflight failed for destination "${destKey}" (${destEntry.adapter}): ${result.error}`,
      )
    }
    log('info', `preflight ok: "${destKey}"`, {
      adapter: destEntry.adapter,
      ...(result.detail ? { detail: result.detail } : {}),
    })
  }

  // Build the picker loop's destinations map: only the reviewed destinations
  // participate in pick detection (needs-attention is for ops review, not
  // operator pick). We snapshot adapter + config here so the picker loop
  // doesn't have to re-resolve the brand-kit on every iteration.
  const pickerDestinations = new Map<
    string,
    { adapter: DestinationAdapter; config: Record<string, unknown> }
  >()
  for (const sourceName of names) {
    const entry = sources[sourceName]!
    const destEntry =
      brandKit.destinations!.entries[entry.reviewed_destination]!
    pickerDestinations.set(entry.reviewed_destination, {
      adapter: destinationRegistry.get(destEntry.adapter)!,
      config: destEntry.config,
    })
  }

  const emitter = pickerEmitter ?? (await buildDefaultEmitter())

  const sourceTasks = names.map((sourceName) =>
    consumeSource({
      sourceName,
      entry: sources[sourceName]!,
      brandKit,
      workspaceRoot,
      signal,
      sourceRegistry,
      destinationRegistry,
      generateFn,
      log,
      sidecarPath,
    }),
  )

  const tasks: Promise<void>[] = [...sourceTasks]
  if (!disablePicker) {
    tasks.push(
      pickerLoop({
        sidecarPath,
        pollIntervalMs: pickerPollIntervalMs,
        destinations: pickerDestinations,
        emitter,
        ...(signal ? { signal } : {}),
        log: (level, msg, meta) => log(level, `[picker] ${msg}`, meta),
      }),
    )
    log('info', `picker loop armed`, {
      pollMs: pickerPollIntervalMs,
      sidecar: sidecarPath,
    })
  }

  await Promise.all(tasks)

  if (emitter.flush) {
    try {
      await emitter.flush()
    } catch {
      // best effort
    }
  }

  log('info', 'all sources drained or aborted; daemon exiting')
}

interface ConsumeSourceArgs {
  sourceName: string
  entry: NonNullable<BrandKit['input_sources']>['entries'][string]
  brandKit: BrandKit
  workspaceRoot: string
  signal: AbortSignal | undefined
  sourceRegistry: Map<string, BriefSource>
  destinationRegistry: Map<string, DestinationAdapter>
  generateFn: typeof generate
  log: WatchLogger
  sidecarPath: string
}

async function consumeSource(args: ConsumeSourceArgs): Promise<void> {
  const adapter = args.sourceRegistry.get(args.entry.adapter)!
  const iter = adapter.watch({
    config: args.entry.config,
    ctx: { workspaceRoot: args.workspaceRoot, brandKit: args.brandKit },
  })

  args.log('info', `source "${args.sourceName}" started`, {
    adapter: args.entry.adapter,
  })

  try {
    for await (const event of iter) {
      if (args.signal?.aborted) {
        args.log('info', `source "${args.sourceName}" aborted by signal`)
        break
      }
      await handleEvent({ ...args, event })
    }
  } catch (err) {
    args.log('error', `source "${args.sourceName}" loop failed`, {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  args.log('info', `source "${args.sourceName}" drained`)
}

async function handleEvent(
  args: ConsumeSourceArgs & { event: BriefEvent },
): Promise<void> {
  const {
    event,
    entry,
    brandKit,
    log,
    generateFn,
    destinationRegistry,
    sourceName,
  } = args
  const sourceLabel = String(event.metadata['sourcePath'] ?? event.id)

  log('info', `event received from "${sourceName}"`, {
    sourceId: event.id,
    sourcePath: sourceLabel,
  })

  let run: GenerationRun
  try {
    run = await generateFn({
      brief: event.brief,
      brandKit,
      ...(event.sourceDocument !== undefined
        ? { sourceDocument: event.sourceDocument }
        : {}),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('error', `generate() failed for "${sourceLabel}"`, { error: msg })
    await publishNeedsAttention({
      args,
      sourceLabel,
      body: `# generate() failed\n\nSource: ${sourceLabel}\nID: ${event.id}\n\nError:\n\n\`\`\`\n${msg}\n\`\`\`\n`,
    })
    return
  }

  const destEntry = brandKit.destinations!.entries[entry.reviewed_destination]!
  const destAdapter = destinationRegistry.get(destEntry.adapter)!

  let publishedOk = 0
  let publishedErr = 0
  let skippedFailed = 0
  const publishedVariants: PublishedVariant[] = []
  const failedVariants: { model: string; text: string }[] = []

  for (const [i, graded] of run.graded.entries()) {
    // Variants where the underlying model call failed are emitted by
    // generate() as "[model call failed: ...]" placeholders. Publishing
    // those to /reviewed pollutes the human review surface AND lets the
    // picker accidentally "pick" an error message. Route them to
    // /needs-attention with the original error preserved instead.
    if (graded.variant.text.startsWith('[model call failed:')) {
      skippedFailed++
      failedVariants.push({
        model: graded.variant.model,
        text: graded.variant.text,
      })
      log('warn', `model call failed for variant ${i} of "${sourceLabel}"`, {
        model: graded.variant.model,
      })
      continue
    }

    const ctx: FilenameContext = {
      sourceId: event.id,
      sourceName: sourceLabel,
      variantIndex: i,
      variantModel: graded.variant.model,
      score: graded.score,
    }
    const config = withResolvedFilename(destEntry.config, ctx)

    const result = await destAdapter.publish({
      copy: graded.variant.text,
      targetName: entry.reviewed_destination,
      config,
    })

    if (result.ok) {
      publishedOk++
      log('info', `published variant ${i} for "${sourceLabel}"`, {
        model: graded.variant.model,
        score: graded.score,
        url: result.url,
      })
      if (result.fileId) {
        publishedVariants.push({
          variantId: graded.variant.id,
          model: graded.variant.model,
          fileId: result.fileId,
          score: graded.score,
        })
      }
    } else {
      publishedErr++
      log('error', `publish failed for variant ${i} of "${sourceLabel}"`, {
        error: result.error,
      })
    }
  }

  // Three ways to need attention:
  //   1. Every successful-text variant failed to publish (drive quota etc).
  //   2. No variants succeeded at the model level (all models 401'd).
  //   3. Some models failed, some succeeded — partial failure that's still
  //      worth surfacing so we don't silently degrade.
  if (publishedOk === 0 && (publishedErr > 0 || skippedFailed > 0)) {
    const lines: string[] = [
      `# all variants failed for "${sourceLabel}"`,
      ``,
      `Source: ${sourceLabel}`,
      `ID: ${event.id}`,
      `Run: ${run.runId}`,
      `Variants attempted: ${run.graded.length}`,
      `Model failures: ${skippedFailed}`,
      `Publish failures: ${publishedErr}`,
    ]
    if (failedVariants.length > 0) {
      lines.push('', '## Model call errors', '')
      for (const fv of failedVariants) {
        lines.push(`### ${fv.model}`, '', '```', fv.text, '```', '')
      }
    }
    await publishNeedsAttention({
      args,
      sourceLabel,
      body: lines.join('\n'),
    })
  } else if (skippedFailed > 0) {
    // Partial failure — succeeded variants are in /reviewed, but flag the
    // failed models so the operator knows they're missing options.
    const lines: string[] = [
      `# partial failure for "${sourceLabel}"`,
      ``,
      `Source: ${sourceLabel}`,
      `Run: ${run.runId}`,
      `Succeeded: ${publishedOk} variants in /reviewed`,
      `Failed: ${skippedFailed} model(s)`,
      ``,
      `## Failing models`,
      ``,
    ]
    for (const fv of failedVariants) {
      lines.push(`### ${fv.model}`, '', '```', fv.text, '```', '')
    }
    await publishNeedsAttention({
      args,
      sourceLabel,
      body: lines.join('\n'),
    })
  }

  // Persist a publish entry for the picker loop iff at least one variant
  // landed AND the destination adapter supports pick detection. Otherwise
  // there's no signal to wait for and the sidecar would grow unbounded.
  if (publishedVariants.length > 0 && destAdapter.detectPick) {
    await recordPublish(args.sidecarPath, {
      runId: run.runId,
      sourceId: event.id,
      sourceName: sourceLabel,
      destinationKey: entry.reviewed_destination,
      publishedAtIso: new Date().toISOString(),
      variants: publishedVariants,
    })
  }

  // Route the trace into the reviewers' annotation queue iff configured + we got
  // any variants out. Best-effort: failures here don't fail the publish.
  const queueId = brandKit.langfuse?.annotation_queue_id
  if (publishedVariants.length > 0 && queueId) {
    const routed = await routeToAnnotationQueue({
      queueId,
      traceId: run.runId,
      log: (level, msg, meta) => log(level, `[queue] ${msg}`, meta),
    })
    if (routed) {
      log('info', `routed trace to annotation queue`, {
        queueId,
        runId: run.runId,
      })
    }
  }

  log('info', `event "${sourceLabel}" complete`, {
    variants: run.graded.length,
    ok: publishedOk,
    publishFailed: publishedErr,
    modelFailed: skippedFailed,
  })
}

async function publishNeedsAttention(args: {
  args: ConsumeSourceArgs
  sourceLabel: string
  body: string
  /** Optional context for filename templating. When omitted we use the
   *  event id as both source identifiers and zero-values for the variant
   *  fields (needs-attention markers don't have a single owning variant). */
  filenameContext?: FilenameContext
}): Promise<void> {
  const { args: ca, sourceLabel, body, filenameContext } = args
  const naKey = ca.entry.needs_attention_destination
  if (!naKey) return
  const naEntry = ca.brandKit.destinations!.entries[naKey]!
  const naAdapter = ca.destinationRegistry.get(naEntry.adapter)!
  const fallbackCtx: FilenameContext = {
    sourceId: sourceLabel,
    sourceName: sourceLabel,
    variantIndex: 0,
    variantModel: 'needs-attention',
    score: 0,
  }
  const config = withResolvedFilename(
    naEntry.config,
    filenameContext ?? fallbackCtx,
  )
  const result = await naAdapter.publish({
    copy: body,
    targetName: naKey,
    config,
  })
  if (!result.ok) {
    ca.log(
      'error',
      `needs-attention publish ALSO failed for "${sourceLabel}"`,
      {
        error: result.error,
      },
    )
  }
}
