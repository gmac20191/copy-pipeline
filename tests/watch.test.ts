import { describe, expect, it } from 'vitest'

import type { BrandKit } from '../src/brand-kit.js'
import type {
  DestinationAdapter,
  PublishArgs,
  ShipResult,
} from '../src/destination/index.js'
import type { GenerationRun } from '../src/types.js'
import {
  applyFilenameTemplate,
  watchAll,
  type FilenameContext,
} from '../src/watch.js'
import type { BriefEvent, BriefSource } from '../src/source/index.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function brandKit(over: Partial<BrandKit> = {}): BrandKit {
  return {
    name: 'test',
    version: '0.1.0',
    canonicals: { marketing: { spec: 'docs/brand/CANONICAL.md' } },
    corpora: {},
    models: { candidates: ['x/a', 'x/b'], grader: 'x/g' },
    destinations: {
      entries: {
        'drive-reviewed': { adapter: 'fake-dest', config: {} },
        'drive-needs-attention': {
          adapter: 'fake-dest',
          config: { folder: 'needs-attention' },
        },
      },
    },
    input_sources: {
      entries: {
        primary: {
          adapter: 'fake-source',
          config: {},
          reviewed_destination: 'drive-reviewed',
          needs_attention_destination: 'drive-needs-attention',
        },
      },
    },
    ...over,
  }
}

function fakeSource(events: BriefEvent[]): BriefSource {
  return {
    name: 'fake-source',
    async *watch(): AsyncIterable<BriefEvent> {
      for (const e of events) yield e
    },
  }
}

interface PublishCall {
  copy: string
  targetName: string
  config: Record<string, unknown>
}

function fakeDestination(opts?: {
  onPublish?: (args: PublishArgs) => void
  fail?: boolean
}): { adapter: DestinationAdapter; calls: PublishCall[] } {
  const calls: PublishCall[] = []
  const adapter: DestinationAdapter = {
    name: 'fake-dest',
    async publish(args: PublishArgs): Promise<ShipResult> {
      calls.push({
        copy: args.copy,
        targetName: args.targetName,
        config: args.config,
      })
      opts?.onPublish?.(args)
      if (opts?.fail) {
        return {
          ok: false,
          destinationName: args.targetName,
          adapterName: 'fake-dest',
          error: 'simulated publish failure',
        }
      }
      return {
        ok: true,
        destinationName: args.targetName,
        adapterName: 'fake-dest',
        detail: `wrote ${args.copy.length} chars`,
      }
    },
  }
  return { adapter, calls }
}

function fakeRun(over?: Partial<GenerationRun>): GenerationRun {
  return {
    runId: 'run-1',
    brief: { text: 'transform me' },
    brandKit: brandKit(),
    groundingChunks: [],
    graded: [
      {
        variant: { id: 'v0', model: 'x/a', text: 'variant A text' },
        findings: [],
        score: 0.9,
      },
      {
        variant: { id: 'v1', model: 'x/b', text: 'variant B text' },
        findings: [],
        score: 0.7,
      },
    ],
    ...over,
  }
}

const silentLog = (): void => undefined

// ─── applyFilenameTemplate ───────────────────────────────────────────────────

describe('applyFilenameTemplate', () => {
  const ctx: FilenameContext = {
    sourceId: 'doc-1',
    sourceName: 'My Draft.gdoc',
    variantIndex: 2,
    variantModel: 'x-ai/grok-4',
    score: 0.873,
  }

  it('substitutes all placeholders + slash-safes the model id', () => {
    expect(
      applyFilenameTemplate(
        '{{source_name}}-v{{variant_index}}-{{variant_model}}-{{score}}.md',
        ctx,
      ),
    ).toBe('My Draft.gdoc-v2-x-ai_grok-4-0.87.md')
  })

  it('leaves a template with no placeholders alone', () => {
    expect(applyFilenameTemplate('static.md', ctx)).toBe('static.md')
  })
})

// ─── watchAll happy path ─────────────────────────────────────────────────────

describe('watchAll', () => {
  it('publishes every graded variant for every event to the reviewed destination', async () => {
    const events: BriefEvent[] = [
      {
        id: 'doc-1',
        brief: { text: 't' },
        sourceDocument: 'orig 1',
        metadata: { sourcePath: 'Doc 1.gdoc' },
      },
    ]
    const src = fakeSource(events)
    const dest = fakeDestination()

    await watchAll({
      brandKit: brandKit(),
      workspaceRoot: '/tmp',
      sourceRegistry: new Map([['fake-source', src]]),
      destinationRegistry: new Map([['fake-dest', dest.adapter]]),
      generate: async () => fakeRun(),
      log: silentLog,
      disablePicker: true,
    })

    expect(dest.calls).toHaveLength(2) // 2 variants per event
    expect(dest.calls[0]?.targetName).toBe('drive-reviewed')
    expect(dest.calls[0]?.copy).toBe('variant A text')
    expect(dest.calls[1]?.copy).toBe('variant B text')
  })

  it('pre-resolves per-event filename placeholders into the destination config', async () => {
    const kit = brandKit({
      destinations: {
        entries: {
          'drive-reviewed': {
            adapter: 'fake-dest',
            config: {
              filename:
                '{{source_name}}-v{{variant_index}}-{{variant_model}}-{{score}}.md',
            },
          },
          'drive-needs-attention': {
            adapter: 'fake-dest',
            config: {},
          },
        },
      },
    })
    const dest = fakeDestination()

    await watchAll({
      brandKit: kit,
      workspaceRoot: '/tmp',
      sourceRegistry: new Map([
        [
          'fake-source',
          fakeSource([
            {
              id: 'doc-1',
              brief: { text: 't' },
              metadata: { sourcePath: 'Review draft.gdoc' },
            },
          ]),
        ],
      ]),
      destinationRegistry: new Map([['fake-dest', dest.adapter]]),
      generate: async () => fakeRun(),
      log: silentLog,
      disablePicker: true,
    })

    expect(dest.calls[0]?.config['filename']).toBe(
      'Review draft.gdoc-v0-x_a-0.90.md',
    )
    expect(dest.calls[1]?.config['filename']).toBe(
      'Review draft.gdoc-v1-x_b-0.70.md',
    )
  })

  it('writes a needs-attention marker when generate() throws', async () => {
    // Both keys share one fake-dest implementation but routed by targetName.
    const calls: PublishCall[] = []
    const sharedDest: DestinationAdapter = {
      name: 'fake-dest',
      async publish(args) {
        calls.push({
          copy: args.copy,
          targetName: args.targetName,
          config: args.config,
        })
        return {
          ok: true,
          destinationName: args.targetName,
          adapterName: 'fake-dest',
        }
      },
    }
    await watchAll({
      brandKit: brandKit(),
      workspaceRoot: '/tmp',
      sourceRegistry: new Map([
        [
          'fake-source',
          fakeSource([
            {
              id: 'doc-1',
              brief: { text: 't' },
              metadata: { sourcePath: 'broken.gdoc' },
            },
          ]),
        ],
      ]),
      destinationRegistry: new Map([['fake-dest', sharedDest]]),
      generate: async () => {
        throw new Error('llm provider timeout')
      },
      log: silentLog,
      disablePicker: true,
    })

    // Only the needs-attention publish should fire — no reviewed publishes.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.targetName).toBe('drive-needs-attention')
    expect(calls[0]?.copy).toContain('generate() failed')
    expect(calls[0]?.copy).toContain('broken.gdoc')
    expect(calls[0]?.copy).toContain('llm provider timeout')
  })

  it('writes needs-attention when every publish fails (but generate succeeded)', async () => {
    const calls: PublishCall[] = []
    const dest: DestinationAdapter = {
      name: 'fake-dest',
      async publish(args) {
        calls.push({
          copy: args.copy,
          targetName: args.targetName,
          config: args.config,
        })
        // Reviewed pubs fail; needs-attention succeeds.
        if (args.targetName === 'drive-reviewed') {
          return {
            ok: false,
            destinationName: args.targetName,
            adapterName: 'fake-dest',
            error: 'drive quota exceeded',
          }
        }
        return {
          ok: true,
          destinationName: args.targetName,
          adapterName: 'fake-dest',
        }
      },
    }

    await watchAll({
      brandKit: brandKit(),
      workspaceRoot: '/tmp',
      sourceRegistry: new Map([
        [
          'fake-source',
          fakeSource([
            {
              id: 'doc-1',
              brief: { text: 't' },
              metadata: { sourcePath: 'doomed.gdoc' },
            },
          ]),
        ],
      ]),
      destinationRegistry: new Map([['fake-dest', dest]]),
      generate: async () => fakeRun(),
      log: silentLog,
      disablePicker: true,
    })

    // Two reviewed attempts + one needs-attention marker
    expect(calls).toHaveLength(3)
    expect(calls[0]?.targetName).toBe('drive-reviewed')
    expect(calls[1]?.targetName).toBe('drive-reviewed')
    expect(calls[2]?.targetName).toBe('drive-needs-attention')
    expect(calls[2]?.copy).toContain('all variants failed')
    expect(calls[2]?.copy).toContain('Publish failures: 2')
  })

  it('routes "[model call failed: ...]" variants to /needs-attention, not /reviewed', async () => {
    const calls: PublishCall[] = []
    const dest: DestinationAdapter = {
      name: 'fake-dest',
      async publish(args) {
        calls.push({
          copy: args.copy,
          targetName: args.targetName,
          config: args.config,
        })
        return {
          ok: true,
          destinationName: args.targetName,
          adapterName: 'fake-dest',
          fileId: 'f0',
        }
      },
    }

    // Both variants are placeholder failures from generate() — the daemon
    // should NOT publish either to /reviewed.
    const failedRun = fakeRun({
      graded: [
        {
          variant: {
            id: 'v0',
            model: 'google-vertex/gemini-2.5-flash',
            text: '[model call failed: google-vertex/gemini-2.5-flash]\n\nNot Found',
          },
          findings: [],
          score: 0.75,
        },
        {
          variant: {
            id: 'v1',
            model: 'anthropic-vertex/claude-haiku-4-5',
            text: '[model call failed: anthropic-vertex/claude-haiku-4-5]\n\nNot Found',
          },
          findings: [],
          score: 0.75,
        },
      ],
    })

    await watchAll({
      brandKit: brandKit(),
      workspaceRoot: '/tmp',
      sourceRegistry: new Map([
        [
          'fake-source',
          fakeSource([
            {
              id: 'doc-1',
              brief: { text: 't' },
              metadata: { sourcePath: 'all-models-down.gdoc' },
            },
          ]),
        ],
      ]),
      destinationRegistry: new Map([['fake-dest', dest]]),
      generate: async () => failedRun,
      log: silentLog,
      disablePicker: true,
    })

    // Exactly one publish: the needs-attention marker. No /reviewed
    // publishes at all (both variants were failed placeholders).
    expect(calls).toHaveLength(1)
    expect(calls[0]?.targetName).toBe('drive-needs-attention')
    expect(calls[0]?.copy).toContain('Model failures: 2')
    expect(calls[0]?.copy).toContain('google-vertex/gemini-2.5-flash')
    expect(calls[0]?.copy).toContain('anthropic-vertex/claude-haiku-4-5')
  })

  it('partial failure: 1 model failed + 1 succeeded → 1 in /reviewed + warning in /needs-attention', async () => {
    const calls: PublishCall[] = []
    const dest: DestinationAdapter = {
      name: 'fake-dest',
      async publish(args) {
        calls.push({
          copy: args.copy,
          targetName: args.targetName,
          config: args.config,
        })
        return {
          ok: true,
          destinationName: args.targetName,
          adapterName: 'fake-dest',
          fileId: `f-${calls.length}`,
        }
      },
    }

    const mixedRun = fakeRun({
      graded: [
        {
          variant: {
            id: 'v0',
            model: 'google-vertex/gemini-2.5-flash',
            text: 'real polished prose here',
          },
          findings: [],
          score: 0.9,
        },
        {
          variant: {
            id: 'v1',
            model: 'anthropic-vertex/claude-haiku-4-5',
            text: '[model call failed: anthropic-vertex/claude-haiku-4-5]\n\nNot Found',
          },
          findings: [],
          score: 0.5,
        },
      ],
    })

    await watchAll({
      brandKit: brandKit(),
      workspaceRoot: '/tmp',
      sourceRegistry: new Map([
        [
          'fake-source',
          fakeSource([
            {
              id: 'doc-1',
              brief: { text: 't' },
              metadata: { sourcePath: 'partial.gdoc' },
            },
          ]),
        ],
      ]),
      destinationRegistry: new Map([['fake-dest', dest]]),
      generate: async () => mixedRun,
      log: silentLog,
      disablePicker: true,
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.targetName).toBe('drive-reviewed')
    expect(calls[0]?.copy).toBe('real polished prose here')
    expect(calls[1]?.targetName).toBe('drive-needs-attention')
    expect(calls[1]?.copy).toContain('partial failure')
    expect(calls[1]?.copy).toContain('Succeeded: 1 variants in /reviewed')
    expect(calls[1]?.copy).toContain('Failed: 1 model(s)')
  })

  it('throws up front when a source references an unregistered adapter', async () => {
    const src = fakeSource([])
    const dest = fakeDestination()
    const kit = brandKit({
      input_sources: {
        entries: {
          primary: {
            adapter: 'no-such-adapter',
            config: {},
            reviewed_destination: 'drive-reviewed',
          },
        },
      },
    })

    await expect(
      watchAll({
        brandKit: kit,
        workspaceRoot: '/tmp',
        sourceRegistry: new Map([['fake-source', src]]),
        destinationRegistry: new Map([['fake-dest', dest.adapter]]),
        generate: async () => fakeRun(),
        log: silentLog,
        disablePicker: true,
      }),
    ).rejects.toThrow(/unregistered adapter "no-such-adapter"/)
  })

  it('throws when a source references a destination key not in brand-kit', async () => {
    const src = fakeSource([])
    const dest = fakeDestination()
    const kit = brandKit({
      input_sources: {
        entries: {
          primary: {
            adapter: 'fake-source',
            config: {},
            reviewed_destination: 'ghost-dest',
          },
        },
      },
    })

    await expect(
      watchAll({
        brandKit: kit,
        workspaceRoot: '/tmp',
        sourceRegistry: new Map([['fake-source', src]]),
        destinationRegistry: new Map([['fake-dest', dest.adapter]]),
        generate: async () => fakeRun(),
        log: silentLog,
        disablePicker: true,
      }),
    ).rejects.toThrow(/not found in brand-kit/)
  })

  it('returns quietly when no sources are configured', async () => {
    const kit = brandKit({ input_sources: { entries: {} } })
    let infoCount = 0
    await watchAll({
      brandKit: kit,
      workspaceRoot: '/tmp',
      sourceRegistry: new Map(),
      destinationRegistry: new Map(),
      generate: async () => fakeRun(),
      log: (level) => {
        if (level === 'info' || level === 'warn') infoCount++
      },
    })
    expect(infoCount).toBeGreaterThan(0) // we logged something
  })

  it('runs preflight on every referenced destination at startup', async () => {
    const preflightCalls: string[] = []
    const dest: DestinationAdapter = {
      name: 'fake-dest',
      async publish(args) {
        return {
          ok: true,
          destinationName: args.targetName,
          adapterName: 'fake-dest',
        }
      },
      async preflight(args) {
        preflightCalls.push(args.targetName)
        return {
          ok: true,
          destinationName: args.targetName,
          adapterName: 'fake-dest',
          detail: 'ok',
        }
      },
    }

    await watchAll({
      brandKit: brandKit(),
      workspaceRoot: '/tmp',
      sourceRegistry: new Map([['fake-source', fakeSource([])]]),
      destinationRegistry: new Map([['fake-dest', dest]]),
      generate: async () => fakeRun(),
      log: silentLog,
      disablePicker: true,
    })

    expect(preflightCalls).toContain('drive-reviewed')
    expect(preflightCalls).toContain('drive-needs-attention')
  })

  it('throws when preflight fails for a referenced destination', async () => {
    const dest: DestinationAdapter = {
      name: 'fake-dest',
      async publish(args) {
        return {
          ok: true,
          destinationName: args.targetName,
          adapterName: 'fake-dest',
        }
      },
      async preflight(args) {
        if (args.targetName === 'drive-reviewed') {
          return {
            ok: false,
            destinationName: args.targetName,
            adapterName: 'fake-dest',
            error: 'simulated preflight failure',
          }
        }
        return {
          ok: true,
          destinationName: args.targetName,
          adapterName: 'fake-dest',
        }
      },
    }

    await expect(
      watchAll({
        brandKit: brandKit(),
        workspaceRoot: '/tmp',
        sourceRegistry: new Map([['fake-source', fakeSource([])]]),
        destinationRegistry: new Map([['fake-dest', dest]]),
        generate: async () => fakeRun(),
        log: silentLog,
        disablePicker: true,
      }),
    ).rejects.toThrow(/preflight failed.*simulated preflight failure/)
  })

  it('skips preflight silently for adapters that do not implement it', async () => {
    // No preflight method at all on this adapter.
    const dest = fakeDestination()
    let started = false
    await watchAll({
      brandKit: brandKit(),
      workspaceRoot: '/tmp',
      sourceRegistry: new Map([['fake-source', fakeSource([])]]),
      destinationRegistry: new Map([['fake-dest', dest.adapter]]),
      generate: async () => fakeRun(),
      log: (level, msg) => {
        if (level === 'info' && msg.includes('starting watch')) started = true
      },
      disablePicker: true,
    })
    expect(started).toBe(true) // no throw, daemon proceeded
  })
})
