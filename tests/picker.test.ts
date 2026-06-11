import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import type {
  DestinationAdapter,
  DetectPickArgs,
  DetectPickResult,
} from '../src/destination/index.js'
import {
  pickerLoop,
  processOneIteration,
  readSidecar,
  recordPublish,
  writeSidecar,
  type PickScoreEmitter,
  type PublishRecord,
} from '../src/picker.js'

let sidecarPath: string

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'picker-test-'))
  sidecarPath = join(dir, 'sidecar.json')
})

// ─── Sidecar IO ──────────────────────────────────────────────────────────────

describe('sidecar IO', () => {
  it('readSidecar returns empty on missing file', async () => {
    const s = await readSidecar(sidecarPath)
    expect(s.publishes).toEqual([])
  })

  it('writeSidecar + readSidecar round-trip a record', async () => {
    const record: PublishRecord = {
      runId: 'run-1',
      sourceId: 's1',
      sourceName: 'draft.gdoc',
      destinationKey: 'drive-reviewed',
      publishedAtIso: '2026-05-25T10:00:00Z',
      variants: [{ variantId: 'v0', model: 'x/a', fileId: 'f1', score: 0.9 }],
    }
    await writeSidecar(sidecarPath, { publishes: [record] })
    const s = await readSidecar(sidecarPath)
    expect(s.publishes).toHaveLength(1)
    expect(s.publishes[0]?.runId).toBe('run-1')
  })

  it('recordPublish appends', async () => {
    await recordPublish(sidecarPath, {
      runId: 'r1',
      sourceId: 's1',
      sourceName: 'a',
      destinationKey: 'd',
      publishedAtIso: '2026-05-25T10:00:00Z',
      variants: [],
    })
    await recordPublish(sidecarPath, {
      runId: 'r2',
      sourceId: 's2',
      sourceName: 'b',
      destinationKey: 'd',
      publishedAtIso: '2026-05-25T10:01:00Z',
      variants: [],
    })
    const s = await readSidecar(sidecarPath)
    expect(s.publishes.map((p) => p.runId)).toEqual(['r1', 'r2'])
  })
})

// ─── Test fixtures ───────────────────────────────────────────────────────────

interface EmitCall {
  traceId: string
  name: string
  value: number
  comment?: string
}

function recordingEmitter(): {
  emitter: PickScoreEmitter
  calls: EmitCall[]
} {
  const calls: EmitCall[] = []
  return {
    emitter: {
      async emit({ traceId, name, value, comment }) {
        calls.push({
          traceId,
          name,
          value,
          ...(comment ? { comment } : {}),
        })
      },
    },
    calls,
  }
}

function fakeAdapter(
  detectByFileId: Record<string, DetectPickResult>,
): DestinationAdapter {
  return {
    name: 'fake-dest',
    async publish() {
      return {
        ok: true,
        destinationName: 'fake',
        adapterName: 'fake-dest',
      }
    },
    async detectPick(args: DetectPickArgs): Promise<DetectPickResult> {
      return detectByFileId[args.fileId] ?? { picked: false }
    },
  }
}

const baseRecord = (over: Partial<PublishRecord> = {}): PublishRecord => ({
  runId: 'run-1',
  sourceId: 'src-1',
  sourceName: 'draft.gdoc',
  destinationKey: 'drive-reviewed',
  publishedAtIso: '2026-05-25T10:00:00Z',
  variants: [
    { variantId: 'v0', model: 'x/a', fileId: 'f0', score: 0.9 },
    { variantId: 'v1', model: 'x/b', fileId: 'f1', score: 0.7 },
  ],
  ...over,
})

const silentLog = (): void => undefined

// ─── processOneIteration ─────────────────────────────────────────────────────

describe('processOneIteration', () => {
  it('detects a pick on one variant + emits picked=1/0 across siblings', async () => {
    await writeSidecar(sidecarPath, { publishes: [baseRecord()] })
    const adapter = fakeAdapter({
      f0: { picked: false },
      f1: {
        picked: true,
        modifiedAtIso: '2026-05-25T10:30:00Z',
        modifiedBy: 'reviewer@example.com',
      },
    })
    const { emitter, calls } = recordingEmitter()

    await processOneIteration({
      sidecarPath,
      destinations: new Map([['drive-reviewed', { adapter, config: {} }]]),
      emitter,
      log: silentLog,
    })

    expect(calls).toHaveLength(2)
    const v0Call = calls.find((c) => c.comment?.includes('not picked'))
    const v1Call = calls.find((c) => c.comment?.includes('picked from'))
    expect(v0Call?.value).toBe(0)
    expect(v1Call?.value).toBe(1)
    expect(v0Call?.traceId).toBe('run-1')
    expect(v1Call?.traceId).toBe('run-1')

    const s = await readSidecar(sidecarPath)
    expect(s.publishes[0]?.picked?.variantId).toBe('v1')
    expect(s.publishes[0]?.picked?.modifiedBy).toBe('reviewer@example.com')
  })

  it('emits nothing when no variant is picked', async () => {
    await writeSidecar(sidecarPath, { publishes: [baseRecord()] })
    const adapter = fakeAdapter({
      f0: { picked: false },
      f1: { picked: false },
    })
    const { emitter, calls } = recordingEmitter()

    await processOneIteration({
      sidecarPath,
      destinations: new Map([['drive-reviewed', { adapter, config: {} }]]),
      emitter,
      log: silentLog,
    })

    expect(calls).toEqual([])
    const s = await readSidecar(sidecarPath)
    expect(s.publishes[0]?.picked).toBeUndefined()
  })

  it('does not re-emit for a record already marked picked', async () => {
    await writeSidecar(sidecarPath, {
      publishes: [
        baseRecord({
          picked: {
            variantId: 'v0',
            fileId: 'f0',
            detectedAtIso: '2026-05-25T10:30:00Z',
          },
        }),
      ],
    })
    const adapter = fakeAdapter({
      f0: { picked: true, modifiedAtIso: '2026-05-25T10:31:00Z' },
      f1: { picked: false },
    })
    const { emitter, calls } = recordingEmitter()

    await processOneIteration({
      sidecarPath,
      destinations: new Map([['drive-reviewed', { adapter, config: {} }]]),
      emitter,
      log: silentLog,
    })

    expect(calls).toEqual([])
  })

  it('prunes a record whose variants are all gone (notFound)', async () => {
    await writeSidecar(sidecarPath, { publishes: [baseRecord()] })
    const adapter = fakeAdapter({
      f0: { picked: false, notFound: true },
      f1: { picked: false, notFound: true },
    })
    const { emitter, calls } = recordingEmitter()

    await processOneIteration({
      sidecarPath,
      destinations: new Map([['drive-reviewed', { adapter, config: {} }]]),
      emitter,
      log: silentLog,
    })

    // No score emitted (can't tell who won).
    expect(calls).toEqual([])
    const s = await readSidecar(sidecarPath)
    expect(s.publishes[0]?.picked?.variantId).toBe('<all-files-missing>')
  })

  it('silently skips destinations whose adapter has no detectPick', async () => {
    await writeSidecar(sidecarPath, { publishes: [baseRecord()] })
    const adapterNoPick: DestinationAdapter = {
      name: 'fake-dest-no-pick',
      async publish() {
        return {
          ok: true,
          destinationName: 'fake',
          adapterName: 'fake-dest-no-pick',
        }
      },
      // no detectPick
    }
    const { emitter, calls } = recordingEmitter()

    await processOneIteration({
      sidecarPath,
      destinations: new Map([
        ['drive-reviewed', { adapter: adapterNoPick, config: {} }],
      ]),
      emitter,
      log: silentLog,
    })

    expect(calls).toEqual([])
    const s = await readSidecar(sidecarPath)
    expect(s.publishes[0]?.picked).toBeUndefined()
  })

  it('handles detectPick throwing on one variant without abandoning the record', async () => {
    await writeSidecar(sidecarPath, { publishes: [baseRecord()] })
    const adapter: DestinationAdapter = {
      name: 'fake-dest',
      async publish() {
        return {
          ok: true,
          destinationName: 'fake',
          adapterName: 'fake-dest',
        }
      },
      async detectPick(args) {
        if (args.fileId === 'f0') throw new Error('transient drive 500')
        return { picked: true, modifiedAtIso: '2026-05-25T10:31:00Z' }
      },
    }
    const { emitter, calls } = recordingEmitter()

    await processOneIteration({
      sidecarPath,
      destinations: new Map([['drive-reviewed', { adapter, config: {} }]]),
      emitter,
      log: silentLog,
    })

    // f1 still got picked despite f0 throwing.
    expect(calls).toHaveLength(2)
    const s = await readSidecar(sidecarPath)
    expect(s.publishes[0]?.picked?.variantId).toBe('v1')
  })
})

// ─── pickerLoop control flow ────────────────────────────────────────────────

describe('pickerLoop', () => {
  it('exits cleanly when the abort signal fires', async () => {
    await writeSidecar(sidecarPath, { publishes: [] })
    const ac = new AbortController()
    let iterations = 0
    const sleep = async (): Promise<void> => {
      // Fire abort after a couple of iterations so the loop has a chance to
      // run + we exercise the abort check.
      if (iterations++ > 2) ac.abort()
    }

    const adapter = fakeAdapter({})
    const { emitter } = recordingEmitter()

    await pickerLoop({
      sidecarPath,
      pollIntervalMs: 1,
      destinations: new Map([['drive-reviewed', { adapter, config: {} }]]),
      emitter,
      signal: ac.signal,
      sleep,
      log: silentLog,
    })

    expect(iterations).toBeGreaterThan(2)
  })
})

// ─── routeToAnnotationQueue ─────────────────────────────────────────────────

import { routeToAnnotationQueue } from '../src/picker.js'

describe('routeToAnnotationQueue', () => {
  it('returns false when LANGFUSE_PUBLIC_KEY is unset (graceful skip)', async () => {
    const prevPk = process.env['LANGFUSE_PUBLIC_KEY']
    const prevSk = process.env['LANGFUSE_SECRET_KEY']
    delete process.env['LANGFUSE_PUBLIC_KEY']
    delete process.env['LANGFUSE_SECRET_KEY']
    try {
      const routed = await routeToAnnotationQueue({
        queueId: 'q1',
        traceId: 't1',
      })
      expect(routed).toBe(false)
    } finally {
      if (prevPk) process.env['LANGFUSE_PUBLIC_KEY'] = prevPk
      if (prevSk) process.env['LANGFUSE_SECRET_KEY'] = prevSk
    }
  })

  it('POSTs to the right endpoint with objectType=TRACE when creds are set', async () => {
    const originalFetch = global.fetch
    let capturedUrl = ''
    let capturedBody: unknown = null
    let capturedHeaders: Record<string, string> = {}
    process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-test'
    process.env['LANGFUSE_SECRET_KEY'] = 'sk-test'
    process.env['LANGFUSE_BASE_URL'] = 'http://lf-test'
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = init?.body ? JSON.parse(init.body as string) : null
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return new Response('{"id":"item-1"}', { status: 200 })
    }) as typeof fetch
    try {
      const ok = await routeToAnnotationQueue({
        queueId: 'q-abc',
        traceId: 'trace-xyz',
      })
      expect(ok).toBe(true)
      expect(capturedUrl).toBe(
        'http://lf-test/api/public/annotation-queues/q-abc/items',
      )
      expect(capturedBody).toEqual({
        objectId: 'trace-xyz',
        objectType: 'TRACE',
      })
      expect(capturedHeaders['Authorization']).toMatch(/^Basic /)
    } finally {
      global.fetch = originalFetch
      delete process.env['LANGFUSE_PUBLIC_KEY']
      delete process.env['LANGFUSE_SECRET_KEY']
      delete process.env['LANGFUSE_BASE_URL']
    }
  })

  it('returns false on non-2xx without throwing', async () => {
    const originalFetch = global.fetch
    process.env['LANGFUSE_PUBLIC_KEY'] = 'pk'
    process.env['LANGFUSE_SECRET_KEY'] = 'sk'
    global.fetch = (async () =>
      new Response('{"error":"queue not found"}', {
        status: 404,
      })) as typeof fetch
    try {
      const ok = await routeToAnnotationQueue({
        queueId: 'no-such',
        traceId: 't',
        log: () => undefined,
      })
      expect(ok).toBe(false)
    } finally {
      global.fetch = originalFetch
      delete process.env['LANGFUSE_PUBLIC_KEY']
      delete process.env['LANGFUSE_SECRET_KEY']
    }
  })
})
