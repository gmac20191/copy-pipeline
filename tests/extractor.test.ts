import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BrandKit } from '../src/brand-kit.js'
import type { Variant } from '../src/types.js'
import type { Verifier, VerifierContext } from '../src/verifier/index.js'
import {
  _clearExtractorRegistry,
  EXTRACTOR_REGISTRY,
  registerExtractor,
  type ClaimExtractor,
  type ClaimExtractorContext,
} from '../src/extractor/index.js'
import { buildDiscoveryMenu, renderMenu } from '../src/extractor/menu.js'
import { wrapClaims } from '../src/extractor/wrap.js'
import {
  buildExtractorPrompt,
  createLLMExtractor,
  type LLMExtractorCall,
} from '../src/extractor/llm.js'

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

function testVariant(text: string): Variant {
  return { id: 'v1', model: 'anthropic/claude-test', text }
}

function testCtx(): ClaimExtractorContext {
  return {
    brandKit: testBrandKit(),
    workspaceRoot: '/tmp',
    verifiers: [],
    briefText: 'write a short paragraph about the product',
  }
}

function fakeVerifier(opts: {
  prefix: string
  name?: string
  refs?: { ref: string; description?: string }[]
  throwInDiscover?: boolean
  hasDiscover?: boolean
}): Verifier {
  const v: Verifier = {
    prefix: opts.prefix,
    name: opts.name ?? `fake-${opts.prefix}`,
    verify: async () => ({
      verdict: 'verified',
      source: { uri: `fake://${opts.prefix}` },
    }),
  }
  if (opts.hasDiscover === false) return v
  v.discover = async () => {
    if (opts.throwInDiscover) throw new Error('discover boom')
    return opts.refs ?? []
  }
  return v
}

beforeEach(() => {
  _clearExtractorRegistry()
})
afterEach(() => {
  _clearExtractorRegistry()
})

// ─── Registry ──────────────────────────────────────────────────────────────

describe('EXTRACTOR_REGISTRY', () => {
  it('registers and looks up extractors by name', () => {
    const ext: ClaimExtractor = {
      name: 'mine',
      extract: async () => ({ text: '', extracted: [], warnings: [] }),
    }
    registerExtractor(ext)
    expect(EXTRACTOR_REGISTRY.get('mine')).toBe(ext)
  })

  it('throws on duplicate name', () => {
    const a: ClaimExtractor = {
      name: 'dup',
      extract: async () => ({ text: '', extracted: [], warnings: [] }),
    }
    const b: ClaimExtractor = { ...a }
    registerExtractor(a)
    expect(() => registerExtractor(b)).toThrow(/Duplicate extractor/)
  })
})

// ─── Menu ──────────────────────────────────────────────────────────────────

describe('buildDiscoveryMenu', () => {
  const verifierCtx = (): VerifierContext => ({
    workspaceRoot: '/tmp',
    brandKit: testBrandKit(),
  })

  it('unions refs from multiple verifiers in parallel', async () => {
    const a = fakeVerifier({
      prefix: 'a',
      refs: [{ ref: 'a:1', description: 'one' }, { ref: 'a:2' }],
    })
    const b = fakeVerifier({
      prefix: 'b',
      refs: [{ ref: 'b:1' }],
    })
    const menu = await buildDiscoveryMenu([a, b], verifierCtx())
    expect(menu.warnings).toEqual([])
    expect(menu.refs.map((r) => r.ref).sort()).toEqual(['a:1', 'a:2', 'b:1'])
  })

  it('skips verifiers without discover()', async () => {
    const undiscover = fakeVerifier({ prefix: 'x', hasDiscover: false })
    const menu = await buildDiscoveryMenu([undiscover], verifierCtx())
    expect(menu.refs).toEqual([])
    expect(menu.warnings).toEqual([])
  })

  it('catches discover() errors as warnings', async () => {
    const ok = fakeVerifier({ prefix: 'ok', refs: [{ ref: 'ok:1' }] })
    const boom = fakeVerifier({ prefix: 'boom', throwInDiscover: true })
    const menu = await buildDiscoveryMenu([ok, boom], verifierCtx())
    expect(menu.refs.map((r) => r.ref)).toEqual(['ok:1'])
    expect(menu.warnings).toHaveLength(1)
    expect(menu.warnings[0]).toMatch(/discover\(\) failed/)
    expect(menu.warnings[0]).toMatch(/boom/)
  })

  it('renderMenu formats refs with optional descriptions', () => {
    const text = renderMenu([
      { ref: 'a:1', description: 'one' },
      { ref: 'a:2' },
    ])
    expect(text).toBe('a:1 — one\na:2')
  })

  it('renderMenu reports empty menu explicitly', () => {
    expect(renderMenu([])).toBe('(no refs available)')
  })
})

// ─── Wrap ──────────────────────────────────────────────────────────────────

describe('wrapClaims', () => {
  it('wraps a single verbatim claim', () => {
    const { text, warnings } = wrapClaims('Acme does X. Then it does Y.', [
      { text: 'Acme does X', ref: 'eval:x' },
    ])
    expect(warnings).toEqual([])
    expect(text).toBe(
      '<claim ref="eval:x">Acme does X</claim>. Then it does Y.',
    )
  })

  it('wraps multiple non-overlapping claims', () => {
    const source = 'A first thing. A second thing.'
    const { text, warnings } = wrapClaims(source, [
      { text: 'A first thing', ref: 'a:1' },
      { text: 'A second thing', ref: 'a:2' },
    ])
    expect(warnings).toEqual([])
    expect(text).toBe(
      '<claim ref="a:1">A first thing</claim>. <claim ref="a:2">A second thing</claim>.',
    )
  })

  it('preserves indices via reverse-application even when claims emit out of order', () => {
    const source = 'A first thing. A second thing.'
    const { text, warnings } = wrapClaims(source, [
      // Note: second claim first in the array.
      { text: 'A second thing', ref: 'a:2' },
      { text: 'A first thing', ref: 'a:1' },
    ])
    expect(warnings).toEqual([])
    expect(text).toBe(
      '<claim ref="a:1">A first thing</claim>. <claim ref="a:2">A second thing</claim>.',
    )
  })

  it('wraps each occurrence when the same text appears twice and is claimed twice', () => {
    const { text, warnings } = wrapClaims('foo. bar. foo. baz.', [
      { text: 'foo', ref: 'a:1' },
      { text: 'foo', ref: 'a:2' },
    ])
    expect(warnings).toEqual([])
    expect(text).toBe(
      '<claim ref="a:1">foo</claim>. bar. <claim ref="a:2">foo</claim>. baz.',
    )
  })

  it('warns and skips claims whose text is missing from the variant', () => {
    const { text, warnings } = wrapClaims('hello world', [
      { text: 'nope', ref: 'a:1' },
    ])
    expect(text).toBe('hello world')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/not found/)
  })

  it('warns and drops overlapping claims', () => {
    const { text, warnings } = wrapClaims(
      'the system retries on transient errors',
      [
        { text: 'the system retries', ref: 'a:1' },
        { text: 'retries on transient errors', ref: 'a:2' },
      ],
    )
    expect(text).toBe(
      '<claim ref="a:1">the system retries</claim> on transient errors',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/overlaps/)
  })

  it('escapes double-quotes in refs', () => {
    const { text } = wrapClaims('x', [{ text: 'x', ref: 'evil:"quote"' }])
    expect(text).toBe('<claim ref="evil:&quot;quote&quot;">x</claim>')
  })

  it('emits warning for empty-text claims', () => {
    const { text, warnings } = wrapClaims('source', [{ text: '', ref: 'a:1' }])
    expect(text).toBe('source')
    expect(warnings[0]).toMatch(/empty claim text/)
  })
})

// ─── Prompt builder ────────────────────────────────────────────────────────

describe('buildExtractorPrompt', () => {
  it('includes the menu, the brief, the brand name, and the variant text', () => {
    const prompt = buildExtractorPrompt({
      variant: testVariant('Acme does X.'),
      ctx: {
        ...testCtx(),
        briefText: 'paragraph about the product',
        brandKit: { ...testBrandKit(), name: 'mybrand' },
      },
      menuText: 'eval:foo — foo desc\nadr:bar',
    })
    expect(prompt).toMatch(/eval:foo — foo desc/)
    expect(prompt).toMatch(/adr:bar/)
    expect(prompt).toMatch(/Brand: mybrand/)
    expect(prompt).toMatch(/paragraph about the product/)
    expect(prompt).toMatch(/Acme does X\./)
  })

  it('explains the needs-evidence fallback', () => {
    const prompt = buildExtractorPrompt({
      variant: testVariant('x'),
      ctx: testCtx(),
      menuText: '(empty)',
    })
    expect(prompt).toMatch(/needs-evidence/)
  })
})

// ─── Full extract via stubbed LLM ──────────────────────────────────────────

describe('createLLMExtractor with stubbed LLM call', () => {
  it('tags claims the LLM returns and reports tokens + latency', async () => {
    const variant = testVariant(
      'Acme auto-detects errors. The system retries the request.',
    )
    const stub: LLMExtractorCall = async () => ({
      claims: [
        { text: 'Acme auto-detects errors', ref: 'eval:error-detect' },
        { text: 'The system retries the request', ref: 'adr:retry-policy' },
      ],
      tokens: { prompt: 120, completion: 40 },
    })

    const extractor = createLLMExtractor({ llmCall: stub })
    const result = await extractor.extract(variant, testCtx())

    expect(result.text).toBe(
      '<claim ref="eval:error-detect">Acme auto-detects errors</claim>. ' +
        '<claim ref="adr:retry-policy">The system retries the request</claim>.',
    )
    expect(result.tokens).toEqual({ prompt: 120, completion: 40 })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.warnings).toEqual([])
  })

  it('builds the discovery menu from registered verifiers and includes warnings', async () => {
    const verifiers: Verifier[] = [
      fakeVerifier({ prefix: 'ok', refs: [{ ref: 'ok:one' }] }),
      fakeVerifier({ prefix: 'boom', throwInDiscover: true }),
    ]

    let capturedPrompt = ''
    const stub: LLMExtractorCall = async ({ prompt }) => {
      capturedPrompt = prompt
      return { claims: [] }
    }

    const extractor = createLLMExtractor({ llmCall: stub })
    const result = await extractor.extract(testVariant('x'), {
      ...testCtx(),
      verifiers,
    })

    expect(capturedPrompt).toMatch(/ok:one/)
    expect(result.warnings.some((w) => /discover\(\) failed/.test(w))).toBe(
      true,
    )
  })

  it('gracefully handles an LLM that throws — variant returned unchanged', async () => {
    const variant = testVariant('Acme does X.')
    const stub: LLMExtractorCall = async () => {
      throw new Error('rate-limited')
    }
    const extractor = createLLMExtractor({ llmCall: stub })
    const result = await extractor.extract(variant, testCtx())

    expect(result.text).toBe('Acme does X.')
    expect(result.extracted).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/rate-limited/)
  })

  it('propagates wrap warnings (e.g. claim text not found verbatim)', async () => {
    const variant = testVariant('the actual prose')
    const stub: LLMExtractorCall = async () => ({
      claims: [{ text: 'a paraphrased version', ref: 'a:1' }],
    })
    const extractor = createLLMExtractor({ llmCall: stub })
    const result = await extractor.extract(variant, testCtx())

    expect(result.text).toBe('the actual prose')
    expect(result.extracted).toHaveLength(1)
    expect(result.warnings.some((w) => /not found/.test(w))).toBe(true)
  })

  it('respects needs-evidence as a literal ref the LLM may emit', async () => {
    const variant = testVariant('This is an aspirational claim.')
    const stub: LLMExtractorCall = async () => ({
      claims: [
        { text: 'This is an aspirational claim', ref: 'needs-evidence' },
      ],
    })
    const extractor = createLLMExtractor({ llmCall: stub })
    const result = await extractor.extract(variant, testCtx())

    expect(result.text).toBe(
      '<claim ref="needs-evidence">This is an aspirational claim</claim>.',
    )
  })
})
