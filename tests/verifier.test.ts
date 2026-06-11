import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BrandKit } from '../src/brand-kit.js'
import {
  _clearVerifierRegistry,
  NEEDS_EVIDENCE_PREFIX,
  registerVerifier,
  getVerifierForRef,
  VERIFIER_REGISTRY,
  type Verifier,
  type VerifierContext,
} from '../src/verifier/index.js'
import { fileVerifier } from '../src/verifier/file.js'
import { parseClaims, verifyClaims } from '../src/verifier/dispatcher.js'

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

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'verifier-test-'))
}

async function ctx(workspaceRoot: string): Promise<VerifierContext> {
  return { workspaceRoot, brandKit: testBrandKit() }
}

beforeEach(() => {
  _clearVerifierRegistry()
})
afterEach(() => {
  _clearVerifierRegistry()
})

describe('VERIFIER_REGISTRY', () => {
  it('registers and looks up a verifier by prefix', () => {
    registerVerifier(fileVerifier)
    expect(VERIFIER_REGISTRY.size).toBe(1)
    expect(getVerifierForRef('file:docs/foo.md')?.name).toBe('file')
  })

  it('throws on duplicate prefix registration', () => {
    registerVerifier(fileVerifier)
    const dup: Verifier = {
      prefix: 'file',
      name: 'shadow-file',
      verify: async () => ({ verdict: 'error', message: 'unreachable' }),
    }
    expect(() => registerVerifier(dup)).toThrow(/Duplicate verifier/)
  })

  it('rejects registration against the reserved needs-evidence prefix', () => {
    const bad: Verifier = {
      prefix: NEEDS_EVIDENCE_PREFIX,
      name: 'pirate',
      verify: async () => ({ verdict: 'error', message: 'unreachable' }),
    }
    expect(() => registerVerifier(bad)).toThrow(/reserved prefix/)
  })

  it('returns undefined for refs with no prefix', () => {
    registerVerifier(fileVerifier)
    expect(getVerifierForRef('justasentence')).toBeUndefined()
  })
})

describe('fileVerifier', () => {
  it('verifies an existing file', async () => {
    const root = await workspace()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'foo.md'), '# foo\n')

    const result = await fileVerifier.verify(
      { claim: 'foo exists', ref: 'docs/foo.md', rawRef: 'file:docs/foo.md' },
      await ctx(root),
    )
    expect(result.verdict).toBe('verified')
    if (result.verdict === 'verified') {
      expect(result.source.uri).toMatch(/^file:\/\//)
    }
  })

  it('returns unverified for a missing file', async () => {
    const root = await workspace()
    const result = await fileVerifier.verify(
      {
        claim: 'foo exists',
        ref: 'docs/missing.md',
        rawRef: 'file:docs/missing.md',
      },
      await ctx(root),
    )
    expect(result.verdict).toBe('unverified')
    if (result.verdict === 'unverified') {
      expect(result.reason).toMatch(/does not exist/)
    }
  })

  it('rejects paths that escape the workspace', async () => {
    const root = await workspace()
    const result = await fileVerifier.verify(
      {
        claim: 'leak',
        ref: '../../../etc/passwd',
        rawRef: 'file:../../../etc/passwd',
      },
      await ctx(root),
    )
    expect(result.verdict).toBe('unverified')
  })

  it('discovers files in the workspace', async () => {
    const root = await workspace()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), 'a')
    await writeFile(join(root, 'docs', 'b.md'), 'b')

    const refs = await fileVerifier.discover!(await ctx(root))
    const ids = refs.map((r) => r.ref).sort()
    expect(ids).toEqual(['file:docs/a.md', 'file:docs/b.md'])
  })
})

describe('parseClaims', () => {
  it('parses a single claim', () => {
    const text = 'Lorem <claim ref="file:docs/x.md">x is true</claim> ipsum.'
    const claims = parseClaims(text)
    expect(claims).toHaveLength(1)
    expect(claims[0]!.rawRef).toBe('file:docs/x.md')
    expect(claims[0]!.text).toBe('x is true')
  })

  it('parses multiple adjacent claims non-greedily', () => {
    const text =
      '<claim ref="file:a">first</claim><claim ref="file:b">second</claim>'
    const claims = parseClaims(text)
    expect(claims).toHaveLength(2)
    expect(claims[0]!.text).toBe('first')
    expect(claims[1]!.text).toBe('second')
  })

  it('handles multi-line claim bodies', () => {
    const text = '<claim ref="adr:foo">line 1\nline 2\nline 3</claim>'
    const claims = parseClaims(text)
    expect(claims).toHaveLength(1)
    expect(claims[0]!.text).toBe('line 1\nline 2\nline 3')
  })

  it('records correct character spans', () => {
    const text = 'AA<claim ref="file:x">y</claim>ZZ'
    const claims = parseClaims(text)
    expect(claims).toHaveLength(1)
    const [start, end] = claims[0]!.span
    expect(text.slice(start, end)).toBe('<claim ref="file:x">y</claim>')
  })

  it('returns empty for text with no claims', () => {
    expect(parseClaims('plain prose, no tags')).toEqual([])
  })

  it('tolerates sibling attrs around ref (presentation metadata)', () => {
    const text =
      '<claim ref="notebooklm:" id="helms-2018" author="Helms ER" year="2018">claim text</claim>'
    const claims = parseClaims(text)
    expect(claims).toHaveLength(1)
    expect(claims[0]!.rawRef).toBe('notebooklm:')
    expect(claims[0]!.text).toBe('claim text')
  })

  it('finds ref when it is not the first attribute', () => {
    const text =
      '<claim id="x" author="Author" ref="file:a.md" year="2026">text</claim>'
    const claims = parseClaims(text)
    expect(claims).toHaveLength(1)
    expect(claims[0]!.rawRef).toBe('file:a.md')
  })

  it('skips a claim tag that has no ref attribute', () => {
    const text = '<claim author="Anon">orphan</claim>'
    expect(parseClaims(text)).toEqual([])
  })
})

describe('verifyClaims dispatcher', () => {
  it('routes claims to the correct verifier', async () => {
    const root = await workspace()
    await writeFile(join(root, 'real.md'), 'hello')
    registerVerifier(fileVerifier)

    const report = await verifyClaims(
      '<claim ref="file:real.md">real exists</claim>',
      await ctx(root),
    )
    expect(report.counts.verified).toBe(1)
    expect(report.counts.total).toBe(1)
  })

  it('separates verified, unverified, error, and needs-evidence counts', async () => {
    const root = await workspace()
    await writeFile(join(root, 'present.md'), '.')
    registerVerifier(fileVerifier)

    const throwy: Verifier = {
      prefix: 'throwy',
      name: 'throwy',
      verify: async () => {
        throw new Error('boom')
      },
    }
    registerVerifier(throwy)

    const text = `
<claim ref="file:present.md">A</claim>
<claim ref="file:absent.md">B</claim>
<claim ref="throwy:foo">C</claim>
<claim ref="needs-evidence">D</claim>
`
    const report = await verifyClaims(text, await ctx(root))
    expect(report.counts).toEqual({
      verified: 1,
      unverified: 1,
      error: 1,
      needsEvidence: 1,
      total: 4,
    })
  })

  it('flags refs whose prefix has no registered verifier as unverified with hint', async () => {
    const root = await workspace()
    const report = await verifyClaims(
      '<claim ref="quokka:nope">X</claim>',
      await ctx(root),
    )
    expect(report.counts.unverified).toBe(1)
    const v = report.claims[0]!.verdict
    expect(v.verdict).toBe('unverified')
    if (v.verdict === 'unverified') {
      expect(v.hint).toMatch(/register a Verifier/)
    }
  })

  it('flags malformed refs (no prefix) as unverified', async () => {
    const root = await workspace()
    const report = await verifyClaims(
      '<claim ref="orphan">X</claim>',
      await ctx(root),
    )
    expect(report.counts.unverified).toBe(1)
    const v = report.claims[0]!.verdict
    if (v.verdict === 'unverified') {
      expect(v.reason).toMatch(/malformed/)
    }
  })

  it('accepts a per-call verifiers override without touching the registry', async () => {
    const root = await workspace()
    await writeFile(join(root, 'override.md'), '.')

    const report = await verifyClaims(
      '<claim ref="file:override.md">A</claim>',
      await ctx(root),
      { verifiers: [fileVerifier] },
    )
    expect(report.counts.verified).toBe(1)
    expect(VERIFIER_REGISTRY.size).toBe(0)
  })

  it('emits empty report for text with no claims', async () => {
    const root = await workspace()
    const report = await verifyClaims('just prose', await ctx(root))
    expect(report.counts.total).toBe(0)
    expect(report.claims).toEqual([])
  })
})
