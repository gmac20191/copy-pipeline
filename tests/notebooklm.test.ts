import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BrandKit } from '../src/brand-kit.js'
import type { VerifierContext } from '../src/verifier/index.js'
import {
  _parseScriptOutput,
  createNotebookLMVerifier,
  buildJudgePrompt,
  type JudgeFn,
  type JudgeResult,
  type NotebookLMCall,
  type NotebookLMRunResult,
} from '../src/verifier/notebooklm.js'

const NOTEBOOK_ID = '00000000-0000-4000-8000-000000000000'

function testBrandKit(): BrandKit {
  return {
    name: 'test',
    version: '0.1.0',
    canonicals: { marketing: { spec: 'docs/brand/CANONICAL.md' } },
    corpora: {},
    models: {
      candidates: ['google/gemini-1.5-pro'],
      grader: 'anthropic/claude-3-5-sonnet-latest',
    },
  }
}

function ctx(): VerifierContext {
  return {
    workspaceRoot: '/tmp/unused-by-notebooklm',
    brandKit: testBrandKit(),
  }
}

function stub(result: NotebookLMRunResult): NotebookLMCall {
  return async () => result
}

function throwingStub(exitCode: number, stderr = 'boom'): NotebookLMCall {
  return async () => {
    const err = Object.assign(new Error(`script exit ${exitCode}: ${stderr}`), {
      exitCode,
      stderr,
    })
    throw err
  }
}

const ENV_KEY = 'NOTEBOOKLM_NOTEBOOK_ID'
let originalEnv: string | undefined

beforeEach(() => {
  originalEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})
afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = originalEnv
})

describe('_parseScriptOutput', () => {
  it('parses response text + citations', () => {
    const out = `MEV for hypertrophy sits around 10 sets/week per muscle [1][2].

--- citations (notebook ${NOTEBOOK_ID}) ---
  [1] schoenfeld-2017-volume-meta.pdf
  [2] israetel-2017-renaissance-periodization.pdf
`
    const r = _parseScriptOutput(out)
    expect(r.responseText).toContain('MEV for hypertrophy')
    expect(r.citations).toEqual([
      { n: 1, file: 'schoenfeld-2017-volume-meta.pdf' },
      { n: 2, file: 'israetel-2017-renaissance-periodization.pdf' },
    ])
    expect(r.notebookId).toBe(NOTEBOOK_ID)
  })

  it('handles zero citations after the header', () => {
    const out = `No relevant sources found.

--- citations (notebook ${NOTEBOOK_ID}) ---
`
    const r = _parseScriptOutput(out)
    expect(r.responseText).toBe('No relevant sources found.')
    expect(r.citations).toEqual([])
    expect(r.notebookId).toBe(NOTEBOOK_ID)
  })

  it('handles output with no citations section at all', () => {
    const out = 'Plain response without a citations block.'
    const r = _parseScriptOutput(out, 'hint-id')
    expect(r.responseText).toBe('Plain response without a citations block.')
    expect(r.citations).toEqual([])
    expect(r.notebookId).toBe('hint-id')
  })

  it('falls back to notebookIdHint when header has <unknown>', () => {
    const out = `Body.

--- citations (notebook <unknown>) ---
  [1] foo.pdf
`
    const r = _parseScriptOutput(out, 'fallback-id')
    expect(r.notebookId).toBe('fallback-id')
    expect(r.citations).toEqual([{ n: 1, file: 'foo.pdf' }])
  })

  it('skips malformed citation lines', () => {
    const out = `Body.

--- citations (notebook x) ---
  [1] valid.pdf
  garbage line
  [2] also-valid.pdf
`
    const r = _parseScriptOutput(out)
    expect(r.citations).toEqual([
      { n: 1, file: 'valid.pdf' },
      { n: 2, file: 'also-valid.pdf' },
    ])
  })
})

describe('notebookLMVerifier', () => {
  it('returns verified when citations are present', async () => {
    const verifier = createNotebookLMVerifier({
      call: stub({
        responseText: 'Body with [1].',
        citations: [
          { n: 1, file: 'schoenfeld-2017.pdf' },
          { n: 2, file: 'helms-2020.pdf' },
        ],
        notebookId: NOTEBOOK_ID,
      }),
    })

    const result = await verifier.verify(
      {
        claim: 'MEV is around 10 sets per muscle',
        ref: NOTEBOOK_ID,
        rawRef: `notebooklm:${NOTEBOOK_ID}`,
      },
      ctx(),
    )
    expect(result.verdict).toBe('verified')
    if (result.verdict === 'verified') {
      expect(result.source.uri).toBe(
        `https://notebooklm.google.com/notebook/${NOTEBOOK_ID}`,
      )
      expect(result.supporting).toContain('[1] schoenfeld-2017.pdf')
      expect(result.supporting).toContain('[2] helms-2020.pdf')
      // Trace must carry the full audit artifact: query, response text,
      // citations, notebook id, timestamp.
      const trace = result.trace as Record<string, unknown> | undefined
      expect(trace).toBeDefined()
      expect(trace?.['verifier']).toBe('notebooklm-claim')
      expect(trace?.['query']).toBe('MEV is around 10 sets per muscle')
      expect(trace?.['responseText']).toBe('Body with [1].')
      expect(trace?.['notebookId']).toBe(NOTEBOOK_ID)
      expect(trace?.['method']).toBe('citations-present')
      expect(typeof trace?.['verifiedAt']).toBe('string')
      expect(Array.isArray(trace?.['citations'])).toBe(true)
    }
  })

  it('returns unverified when no citations are returned', async () => {
    const verifier = createNotebookLMVerifier({
      call: stub({
        responseText: 'No relevant sources.',
        citations: [],
      }),
    })

    const result = await verifier.verify(
      {
        claim: 'an unsupported claim',
        ref: NOTEBOOK_ID,
        rawRef: `notebooklm:${NOTEBOOK_ID}`,
      },
      ctx(),
    )
    expect(result.verdict).toBe('unverified')
    if (result.verdict === 'unverified') {
      expect(result.reason).toMatch(/no citations/)
    }
  })

  it('returns error with rate-limit message when script exits 3', async () => {
    const verifier = createNotebookLMVerifier({
      call: throwingStub(3, 'daily chat limit'),
    })

    const result = await verifier.verify(
      {
        claim: 'x',
        ref: NOTEBOOK_ID,
        rawRef: `notebooklm:${NOTEBOOK_ID}`,
      },
      ctx(),
    )
    expect(result.verdict).toBe('error')
    if (result.verdict === 'error') {
      expect(result.message).toMatch(/daily chat limit/)
    }
  })

  it('returns error for generic script failures', async () => {
    const verifier = createNotebookLMVerifier({
      call: throwingStub(1, 'auth expired'),
    })

    const result = await verifier.verify(
      {
        claim: 'x',
        ref: NOTEBOOK_ID,
        rawRef: `notebooklm:${NOTEBOOK_ID}`,
      },
      ctx(),
    )
    expect(result.verdict).toBe('error')
    if (result.verdict === 'error') {
      expect(result.message).toMatch(/notebooklm-query failed/)
      expect(result.message).toMatch(/auth expired/)
    }
  })

  it('uses ref body as the notebook id (overrides env var)', async () => {
    process.env[ENV_KEY] = 'env-default'
    let receivedId = ''
    const verifier = createNotebookLMVerifier({
      call: async ({ notebookId }) => {
        receivedId = notebookId
        return { responseText: 'ok', citations: [{ n: 1, file: 'x.pdf' }] }
      },
    })

    await verifier.verify(
      {
        claim: 'x',
        ref: 'explicit-id',
        rawRef: 'notebooklm:explicit-id',
      },
      ctx(),
    )
    expect(receivedId).toBe('explicit-id')
  })

  it('falls back to env var when ref body is empty', async () => {
    process.env[ENV_KEY] = 'env-default'
    let receivedId = ''
    const verifier = createNotebookLMVerifier({
      call: async ({ notebookId }) => {
        receivedId = notebookId
        return { responseText: 'ok', citations: [{ n: 1, file: 'x.pdf' }] }
      },
    })

    await verifier.verify({ claim: 'x', ref: '', rawRef: 'notebooklm:' }, ctx())
    expect(receivedId).toBe('env-default')
  })

  it('returns unverified when neither ref body nor env var has a notebook id', async () => {
    delete process.env[ENV_KEY]
    const verifier = createNotebookLMVerifier({
      call: stub({ responseText: '', citations: [] }),
    })

    const result = await verifier.verify(
      { claim: 'x', ref: '', rawRef: 'notebooklm:' },
      ctx(),
    )
    expect(result.verdict).toBe('unverified')
    if (result.verdict === 'unverified') {
      expect(result.reason).toMatch(/no NotebookLM notebook id/)
    }
  })

  it('prefers config.defaultNotebookId over env var', async () => {
    process.env[ENV_KEY] = 'env-default'
    let receivedId = ''
    const verifier = createNotebookLMVerifier({
      defaultNotebookId: 'config-default',
      call: async ({ notebookId }) => {
        receivedId = notebookId
        return { responseText: 'ok', citations: [{ n: 1, file: 'x.pdf' }] }
      },
    })

    await verifier.verify({ claim: 'x', ref: '', rawRef: 'notebooklm:' }, ctx())
    expect(receivedId).toBe('config-default')
  })

  it('passes timeoutSec through to the call', async () => {
    let receivedTimeout: number | undefined
    const verifier = createNotebookLMVerifier({
      timeoutSec: 240,
      call: async ({ timeoutSec }) => {
        receivedTimeout = timeoutSec
        return { responseText: 'ok', citations: [{ n: 1, file: 'x.pdf' }] }
      },
    })

    await verifier.verify(
      {
        claim: 'x',
        ref: NOTEBOOK_ID,
        rawRef: `notebooklm:${NOTEBOOK_ID}`,
      },
      ctx(),
    )
    expect(receivedTimeout).toBe(240)
  })

  it('has no discover method (unbounded ref space)', () => {
    const verifier = createNotebookLMVerifier({
      call: stub({ responseText: '', citations: [] }),
    })
    expect(verifier.discover).toBeUndefined()
  })

  it('has the expected prefix and name', () => {
    const verifier = createNotebookLMVerifier({
      call: stub({ responseText: '', citations: [] }),
    })
    expect(verifier.prefix).toBe('notebooklm')
    expect(verifier.name).toBe('notebooklm-claim')
  })
})

describe('LLM-as-judge step', () => {
  function judgeStub(result: JudgeResult): JudgeFn {
    return async () => result
  }

  it('returns verified when citations exist AND judge says "supports"', async () => {
    const verifier = createNotebookLMVerifier({
      call: stub({
        responseText: 'Strong evidence...',
        citations: [{ n: 1, file: 'schoenfeld.pdf' }],
      }),
      judge: judgeStub({
        verdict: 'supports',
        rationale: 'Schoenfeld 2017 directly establishes this.',
      }),
    })

    const result = await verifier.verify(
      { claim: 'x', ref: NOTEBOOK_ID, rawRef: `notebooklm:${NOTEBOOK_ID}` },
      ctx(),
    )
    expect(result.verdict).toBe('verified')
    if (result.verdict === 'verified') {
      expect(result.supporting).toContain(
        'Schoenfeld 2017 directly establishes',
      )
      expect(result.supporting).toContain('schoenfeld.pdf')
    }
  })

  it('returns unverified with the judge rationale when judge says "contradicts"', async () => {
    const verifier = createNotebookLMVerifier({
      call: stub({
        responseText: 'The corpus disagrees.',
        citations: [{ n: 1, file: 'contradicting.pdf' }],
      }),
      judge: judgeStub({
        verdict: 'contradicts',
        rationale: 'The corpus shows the opposite trend.',
      }),
    })

    const result = await verifier.verify(
      { claim: 'x', ref: NOTEBOOK_ID, rawRef: `notebooklm:${NOTEBOOK_ID}` },
      ctx(),
    )
    expect(result.verdict).toBe('unverified')
    if (result.verdict === 'unverified') {
      expect(result.reason).toMatch(/contradicts the claim/)
      expect(result.reason).toContain('The corpus shows the opposite trend')
      expect(result.hint).toContain('contradicting.pdf')
    }
  })

  it('returns unverified when judge says "inconclusive"', async () => {
    const verifier = createNotebookLMVerifier({
      call: stub({
        responseText: 'Tangentially related work.',
        citations: [{ n: 1, file: 'tangent.pdf' }],
      }),
      judge: judgeStub({
        verdict: 'inconclusive',
        rationale: "Citations exist but don't address the specific claim.",
      }),
    })

    const result = await verifier.verify(
      { claim: 'x', ref: NOTEBOOK_ID, rawRef: `notebooklm:${NOTEBOOK_ID}` },
      ctx(),
    )
    expect(result.verdict).toBe('unverified')
    if (result.verdict === 'unverified') {
      expect(result.reason).toMatch(/do not directly support/)
    }
  })

  it('skips the judge entirely when there are no citations', async () => {
    let judgeCalled = false
    const verifier = createNotebookLMVerifier({
      call: stub({ responseText: 'nothing relevant', citations: [] }),
      judge: async () => {
        judgeCalled = true
        return { verdict: 'supports', rationale: 'unreachable' }
      },
    })

    const result = await verifier.verify(
      { claim: 'x', ref: NOTEBOOK_ID, rawRef: `notebooklm:${NOTEBOOK_ID}` },
      ctx(),
    )
    expect(result.verdict).toBe('unverified')
    expect(judgeCalled).toBe(false)
  })

  it('returns error when the judge throws', async () => {
    const verifier = createNotebookLMVerifier({
      call: stub({
        responseText: '...',
        citations: [{ n: 1, file: 'a.pdf' }],
      }),
      judge: async () => {
        throw new Error('judge model rate-limited')
      },
    })

    const result = await verifier.verify(
      { claim: 'x', ref: NOTEBOOK_ID, rawRef: `notebooklm:${NOTEBOOK_ID}` },
      ctx(),
    )
    expect(result.verdict).toBe('error')
    if (result.verdict === 'error') {
      expect(result.message).toMatch(/LLM judge failed.*rate-limited/)
    }
  })

  it('passes claim + citations + response into the judge', async () => {
    let received: Parameters<JudgeFn>[0] | undefined
    const verifier = createNotebookLMVerifier({
      call: stub({
        responseText: 'corpus says ABC',
        citations: [
          { n: 1, file: 'a.pdf' },
          { n: 2, file: 'b.pdf' },
        ],
      }),
      judge: async (args) => {
        received = args
        return { verdict: 'supports', rationale: 'ok' }
      },
    })

    await verifier.verify(
      {
        claim: 'specific claim under test',
        ref: NOTEBOOK_ID,
        rawRef: `notebooklm:${NOTEBOOK_ID}`,
      },
      ctx(),
    )
    expect(received?.claim).toBe('specific claim under test')
    expect(received?.responseText).toBe('corpus says ABC')
    expect(received?.citations).toEqual([
      { n: 1, file: 'a.pdf' },
      { n: 2, file: 'b.pdf' },
    ])
  })
})

describe('buildJudgePrompt', () => {
  it('embeds the claim, response, and citation index', () => {
    const prompt = buildJudgePrompt({
      claim: 'MEV around ten sets',
      citations: [
        { n: 1, file: 'schoenfeld.pdf' },
        { n: 2, file: 'helms.pdf' },
      ],
      responseText: 'Body of the corpus response.',
    })
    expect(prompt).toContain('MEV around ten sets')
    expect(prompt).toContain('Body of the corpus response.')
    expect(prompt).toContain('[1] schoenfeld.pdf')
    expect(prompt).toContain('[2] helms.pdf')
    expect(prompt).toMatch(/supports.*contradicts.*inconclusive/s)
  })

  it('renders "(none)" when no citations are provided', () => {
    const prompt = buildJudgePrompt({
      claim: 'x',
      citations: [],
      responseText: 'No relevant sources.',
    })
    expect(prompt).toMatch(/Citation index:\s+\(none\)/)
  })
})
