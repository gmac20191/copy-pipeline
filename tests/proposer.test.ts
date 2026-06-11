import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import type { BrandKit } from '../src/brand-kit.js'
import type {
  DestinationAdapter,
  PublishArgs,
  ShipResult,
} from '../src/destination/index.js'
import {
  buildProposerSystemPrompt,
  buildProposerUserPrompt,
  fetchEvidence,
  publishProposals,
  runProposer,
  type EvidenceSummary,
  type EvidenceTrace,
  type LangfuseEvidenceClient,
} from '../src/proposer.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function brandKit(over: Partial<BrandKit> = {}): BrandKit {
  return {
    name: 'smoketest-drive',
    version: '0.1.0',
    canonicals: { marketing: { spec: 'docs/brand/CANONICAL.md' } },
    corpora: {},
    models: {
      candidates: ['google-vertex/gemini-2.5-flash'],
      grader: 'google-vertex/gemini-2.5-flash',
    },
    ...over,
  }
}

interface FakeScore {
  name: string
  value?: number
  stringValue?: string
  comment?: string
  dataType?: string
  observationId?: string | null
}

interface FakeTrace {
  id: string
  briefText: string
  variants: Array<{
    id: string
    model: string
    output: string
    pickedValue?: number
    judgeScore?: number
    brandReviewScore?: number
    /** Arbitrary additional scores (multi-dimensional HITL annotations etc). */
    extraScores?: FakeScore[]
  }>
  traceComments?: string[]
}

function fakeClient(traces: FakeTrace[]): LangfuseEvidenceClient {
  return {
    async fetchTraces() {
      return {
        data: traces.map((t) => ({
          id: t.id,
        })),
      } as Awaited<ReturnType<LangfuseEvidenceClient['fetchTraces']>>
    },
    async fetchTrace(traceId: string) {
      const t = traces.find((x) => x.id === traceId)
      if (!t) throw new Error(`fake-client: no trace ${traceId}`)
      const obs = t.variants.map((v) => ({
        id: v.id,
        name: 'candidate',
        type: 'GENERATION',
        model: v.model,
        output: v.output,
      }))
      const scores: FakeScore[] = []
      for (const v of t.variants) {
        if (v.pickedValue !== undefined) {
          scores.push({
            name: 'picked',
            value: v.pickedValue,
            observationId: v.id,
          })
        }
        if (v.judgeScore !== undefined) {
          scores.push({
            name: 'llm-judge',
            value: v.judgeScore,
            observationId: v.id,
          })
        }
        if (v.brandReviewScore !== undefined) {
          scores.push({
            name: 'brand-review',
            value: v.brandReviewScore,
            observationId: v.id,
          })
        }
        for (const extra of v.extraScores ?? []) {
          scores.push({
            ...extra,
            observationId: extra.observationId ?? v.id,
          })
        }
      }
      return {
        data: {
          id: t.id,
          name: 'copy-pipeline.generate',
          input: { brief: t.briefText },
          metadata: {
            brand_kit: 'smoketest-drive',
            brand_kit_version: '0.1.0',
          },
          observations: obs,
          scores,
        },
      } as Awaited<ReturnType<LangfuseEvidenceClient['fetchTrace']>>
    },
    async fetchTraceComments(traceId: string) {
      return traces.find((t) => t.id === traceId)?.traceComments ?? []
    },
  }
}

let rulesPath: string
let canonicalPath: string

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proposer-test-'))
  rulesPath = join(dir, 'rules.json')
  canonicalPath = join(dir, 'CANONICAL.md')
  await writeFile(
    rulesPath,
    JSON.stringify(
      {
        schema_version: '0.1.0',
        rule_groups: {
          filler_words: {
            severity: 'warning',
            items: [{ id: 'FL-001', pattern: '\\bbasically\\b', regex: true }],
          },
        },
      },
      null,
      2,
    ),
  )
  await writeFile(canonicalPath, '# Test canonical\n\nVoice: tight + direct.')
})

// ─── fetchEvidence ──────────────────────────────────────────────────────────

describe('fetchEvidence', () => {
  it('flattens Langfuse traces into the evidence shape', async () => {
    const traces: FakeTrace[] = [
      {
        id: 'trace-1',
        briefText: 'rewrite this noisy draft',
        variants: [
          {
            id: 'v0',
            model: 'google-vertex/gemini-2.5-flash',
            output: 'gemini rewrite text',
            pickedValue: 0,
            judgeScore: 0.5,
          },
          {
            id: 'v1',
            model: 'anthropic-vertex/claude-haiku-4-5',
            output: 'claude rewrite text',
            pickedValue: 1,
            judgeScore: 0.8,
          },
        ],
      },
    ]
    const evidence = await fetchEvidence({
      client: fakeClient(traces),
      brandKitName: 'smoketest-drive',
      windowDays: 7,
    })

    expect(evidence.totalTraces).toBe(1)
    expect(evidence.pickedTraces).toBe(1)
    expect(evidence.windowDays).toBe(7)
    expect(evidence.traces[0]?.variants).toHaveLength(2)
    const v0 = evidence.traces[0]?.variants[0]
    const v1 = evidence.traces[0]?.variants[1]
    expect(v0?.picked).toBe(false)
    expect(v1?.picked).toBe(true)
    expect(v0?.scores['llm-judge']?.value).toBe(0.5)
    expect(v1?.scores['llm-judge']?.value).toBe(0.8)
  })

  it('handles a trace with no picked score', async () => {
    const evidence = await fetchEvidence({
      client: fakeClient([
        {
          id: 'trace-nopick',
          briefText: 'draft',
          variants: [
            { id: 'v0', model: 'm/a', output: 'text', judgeScore: 0.5 },
          ],
        },
      ]),
      brandKitName: 'smoketest-drive',
      windowDays: 1,
    })
    expect(evidence.totalTraces).toBe(1)
    expect(evidence.pickedTraces).toBe(0)
    expect(evidence.traces[0]?.hasPick).toBe(false)
  })

  it('truncates long outputs to snippetChars', async () => {
    const longText = 'x'.repeat(2000)
    const evidence = await fetchEvidence({
      client: fakeClient([
        {
          id: 'trace-long',
          briefText: 'b',
          variants: [{ id: 'v0', model: 'm/a', output: longText }],
        },
      ]),
      brandKitName: 'smoketest-drive',
      windowDays: 1,
      snippetChars: 100,
    })
    const snip = evidence.traces[0]?.variants[0]?.outputSnippet ?? ''
    expect(snip.length).toBeLessThan(200) // 100 + truncation suffix
    expect(snip).toContain('truncated')
  })

  it('captures Langfuse score comments, categorical labels, and dataType', async () => {
    const evidence = await fetchEvidence({
      client: fakeClient([
        {
          id: 'trace-hitl',
          briefText: 'brief',
          variants: [
            {
              id: 'v0',
              model: 'm/a',
              output: 'text',
              pickedValue: 1,
              extraScores: [
                {
                  name: 'voice',
                  value: 4,
                  comment: 'tight + direct',
                  dataType: 'NUMERIC',
                },
                {
                  name: 'ship-decision',
                  stringValue: 'ship-as-is',
                  dataType: 'CATEGORICAL',
                  comment: 'use this one verbatim',
                },
              ],
            },
          ],
        },
      ]),
      brandKitName: 'smoketest-drive',
      windowDays: 1,
    })
    const v = evidence.traces[0]?.variants[0]
    expect(v?.scores['voice']?.value).toBe(4)
    expect(v?.scores['voice']?.comment).toBe('tight + direct')
    expect(v?.scores['voice']?.dataType).toBe('NUMERIC')
    expect(v?.scores['ship-decision']?.stringValue).toBe('ship-as-is')
    expect(v?.scores['ship-decision']?.dataType).toBe('CATEGORICAL')
    expect(v?.scores['ship-decision']?.comment).toBe('use this one verbatim')
  })

  it('captures trace-level comments via fetchTraceComments', async () => {
    const evidence = await fetchEvidence({
      client: fakeClient([
        {
          id: 'trace-with-comments',
          briefText: 'brief',
          variants: [{ id: 'v0', model: 'm/a', output: 'text' }],
          traceComments: [
            'Whole batch missed the brief — opening line is too long.',
            'The structure is great; just rewrite the CTA.',
          ],
        },
      ]),
      brandKitName: 'smoketest-drive',
      windowDays: 1,
    })
    expect(evidence.traces[0]?.traceComments).toEqual([
      'Whole batch missed the brief — opening line is too long.',
      'The structure is great; just rewrite the CTA.',
    ])
  })

  it('degrades gracefully when fetchTraceComments is unavailable', async () => {
    const client: LangfuseEvidenceClient = {
      ...fakeClient([
        {
          id: 'trace-no-cmts',
          briefText: 'b',
          variants: [{ id: 'v0', model: 'm/a', output: 't' }],
        },
      ]),
    }
    delete (client as { fetchTraceComments?: unknown }).fetchTraceComments
    const evidence = await fetchEvidence({
      client,
      brandKitName: 'smoketest-drive',
      windowDays: 1,
    })
    expect(evidence.traces[0]?.traceComments).toEqual([])
  })

  it('returns empty summary when no traces', async () => {
    const evidence = await fetchEvidence({
      client: fakeClient([]),
      brandKitName: 'empty',
      windowDays: 7,
    })
    expect(evidence.totalTraces).toBe(0)
    expect(evidence.pickedTraces).toBe(0)
    expect(evidence.traces).toEqual([])
  })
})

// ─── Prompt assembly ────────────────────────────────────────────────────────

describe('buildProposerSystemPrompt', () => {
  it('mentions output format + evidence-grounding rule', () => {
    const sys = buildProposerSystemPrompt()
    expect(sys).toContain('brand-kit improver')
    expect(sys).toContain('cite the trace IDs')
    expect(sys).toContain('Proposal 1')
    expect(sys).toContain('Confidence')
  })

  it('tells the LLM to emit zero proposals on thin evidence', () => {
    const sys = buildProposerSystemPrompt()
    expect(sys).toContain('thin')
    expect(sys).toContain('zero proposals')
  })

  it('weights HUMAN ANNOTATIONS above implicit picks and auto graders', () => {
    const sys = buildProposerSystemPrompt()
    expect(sys).toContain('HUMAN ANNOTATIONS')
    expect(sys).toContain('highest signal')
    expect(sys).toContain('IMPLICIT PICKS')
    expect(sys).toContain('AUTO GRADER SCORES')
    // Order matters — humans first, picks second, autos third.
    const humans = sys.indexOf('HUMAN ANNOTATIONS')
    const picks = sys.indexOf('IMPLICIT PICKS')
    const autos = sys.indexOf('AUTO GRADER SCORES')
    expect(humans).toBeGreaterThan(0)
    expect(humans).toBeLessThan(picks)
    expect(picks).toBeLessThan(autos)
  })

  it('tells the LLM to QUOTE annotator comments as evidence', () => {
    const sys = buildProposerSystemPrompt()
    expect(sys).toContain('QUOTE')
    expect(sys).toContain('verbatim')
  })
})

describe('buildProposerUserPrompt', () => {
  function evidence(traces: EvidenceTrace[]): EvidenceSummary {
    return {
      windowDays: 7,
      fetchedAt: '2026-05-26T00:00:00Z',
      totalTraces: traces.length,
      pickedTraces: traces.filter((t) => t.hasPick).length,
      traces,
    }
  }

  it('includes brand-kit, rules, canonical, and per-trace evidence', () => {
    const prompt = buildProposerUserPrompt({
      brandKit: brandKit(),
      rulesJson: '{"rule_groups":{}}',
      canonicalMd: '# Canonical',
      evidence: evidence([
        {
          runId: 'trace-1',
          brandKitName: 'smoketest-drive',
          brandKitVersion: '0.1.0',
          briefSnippet: 'rewrite this',
          hasPick: true,
          traceComments: [
            'Whole batch missed the brief — opening line is too long.',
          ],
          variants: [
            {
              variantId: 'v0',
              model: 'google-vertex/gemini-2.5-flash',
              scores: {
                'llm-judge': { value: 0.5 },
                picked: { value: 0 },
              },
              outputSnippet: 'gemini output here',
              picked: false,
            },
            {
              variantId: 'v1',
              model: 'anthropic-vertex/claude-haiku-4-5',
              scores: {
                'llm-judge': { value: 0.8 },
                picked: { value: 1 },
                voice: { value: 4, comment: 'tight + direct, on-brand' },
                'ship-decision': {
                  stringValue: 'ship-as-is',
                  dataType: 'CATEGORICAL',
                  comment: 'Use this one verbatim.',
                },
              },
              outputSnippet: 'claude output here',
              picked: true,
            },
          ],
        },
      ]),
    })

    expect(prompt).toContain('smoketest-drive')
    expect(prompt).toContain('google-vertex/gemini-2.5-flash')
    expect(prompt).toContain('Current rules.json')
    expect(prompt).toContain('Current CANONICAL.md')
    expect(prompt).toContain('Trace trace-1')
    expect(prompt).toContain('← PICKED')
    expect(prompt).toContain('llm-judge=0.8')
    expect(prompt).toContain('1 have a recorded pick')
    // Categorical score + comment surface in the prompt.
    expect(prompt).toContain('ship-decision="ship-as-is"')
    expect(prompt).toContain('Use this one verbatim.')
    expect(prompt).toContain('tight + direct, on-brand')
    // Trace-level comments surface in the prompt.
    expect(prompt).toContain('Trace-level annotator comments')
    expect(prompt).toContain('Whole batch missed the brief')
  })

  it('emits explicit no-data note when zero traces', () => {
    const prompt = buildProposerUserPrompt({
      brandKit: brandKit(),
      rulesJson: '{}',
      canonicalMd: '#',
      evidence: evidence([]),
    })
    expect(prompt).toContain('No traces in window')
  })
})

// ─── runProposer ────────────────────────────────────────────────────────────

describe('runProposer', () => {
  it('throws when no Langfuse client is available', async () => {
    delete process.env['LANGFUSE_PUBLIC_KEY']
    delete process.env['LANGFUSE_SECRET_KEY']
    await expect(
      runProposer({
        brandKit: brandKit(),
        rulesPath,
        canonicalPath,
        windowDays: 7,
        langfuseClient: null,
      }),
    ).rejects.toThrow(/LANGFUSE_PUBLIC_KEY/)
  })

  it('orchestrates fetch + LLM call + returns a result (analyzer call may fail in CI)', async () => {
    // Inject a fake client with 1 picked trace; orchestrator should pull
    // evidence successfully and proceed to the LLM call. In CI without
    // GCP creds the LLM call fails with the placeholder text — we catch
    // that and verify the orchestrator surfaces it as a thrown error
    // rather than returning a garbage result.
    const result = await runProposer({
      brandKit: brandKit(),
      rulesPath,
      canonicalPath,
      windowDays: 7,
      analyzerModel: 'no-such-provider/no-such-model',
      langfuseClient: fakeClient([
        {
          id: 'trace-1',
          briefText: 'b',
          variants: [{ id: 'v0', model: 'm/a', output: 'o', pickedValue: 1 }],
        },
      ]),
      log: () => undefined,
    }).catch((err) => err as Error)
    // The analyzer model is invalid → generateVariant returns placeholder →
    // runProposer throws.
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('analyzer call failed')
  })
})

// ─── publishProposals ──────────────────────────────────────────────────────

describe('publishProposals', () => {
  it('calls the destination adapter with the proposer markdown', async () => {
    const calls: PublishArgs[] = []
    const dest: DestinationAdapter = {
      name: 'fake-dest',
      async publish(args: PublishArgs): Promise<ShipResult> {
        calls.push(args)
        return {
          ok: true,
          destinationName: args.targetName,
          adapterName: 'fake-dest',
          url: 'https://example/proposals',
        }
      },
    }

    const ship = await publishProposals({
      destinationAdapter: dest,
      destinationName: 'drive-suggestions',
      destinationConfig: { folder_id: 'f1' },
      result: {
        evidence: {
          windowDays: 7,
          fetchedAt: '2026-05-26',
          totalTraces: 0,
          pickedTraces: 0,
          traces: [],
        },
        markdown: '# proposal markdown',
        analyzerModel: 'google-vertex/gemini-2.5-pro',
      },
    })

    expect(ship.ok).toBe(true)
    expect(ship.url).toBe('https://example/proposals')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.copy).toBe('# proposal markdown')
    expect(calls[0]?.targetName).toBe('drive-suggestions')
    expect(calls[0]?.config['folder_id']).toBe('f1')
  })
})
