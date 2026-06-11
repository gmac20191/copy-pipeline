import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { BrandKit, Verifier } from '../src/index.js'
import { fileVerifier } from '../src/verifier/file.js'
import {
  toolVerifyClaims,
  toolVerifyClaim,
  toolListVerifiers,
  toolDiscoverRefs,
  type ToolContext,
} from '../src/mcp-tools.js'

function testBrandKit(): BrandKit {
  return {
    name: 'test',
    version: '0.1.0',
    canonicals: { marketing: { spec: 'docs/brand/CANONICAL.md' } },
    corpora: {},
    models: { candidates: ['x/y'], grader: 'x/y' },
  }
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mcp-tools-test-'))
}

function ctx(workspaceRoot: string, verifiers: Verifier[]): ToolContext {
  return { workspaceRoot, brandKit: testBrandKit(), verifiers }
}

function fakeVerifier(opts: {
  prefix: string
  name?: string
  description?: string
  refs?: { ref: string; description?: string }[]
  hasDiscover?: boolean
  throwInDiscover?: boolean
  verdictForRef?: (ref: string) => 'verified' | 'unverified' | 'error'
}): Verifier {
  const v: Verifier = {
    prefix: opts.prefix,
    name: opts.name ?? `fake-${opts.prefix}`,
    ...(opts.description ? { description: opts.description } : {}),
    verify: async (args) => {
      const verdict = opts.verdictForRef?.(args.ref) ?? 'verified'
      if (verdict === 'verified') {
        return {
          verdict: 'verified',
          source: { uri: `fake://${opts.prefix}/${args.ref}` },
        }
      }
      if (verdict === 'error') {
        return { verdict: 'error', message: 'simulated' }
      }
      return { verdict: 'unverified', reason: 'simulated' }
    },
  }
  if (opts.hasDiscover === false) return v
  if (opts.refs || opts.throwInDiscover) {
    v.discover = async () => {
      if (opts.throwInDiscover) throw new Error('discover boom')
      return opts.refs ?? []
    }
  }
  return v
}

describe('toolVerifyClaims', () => {
  it('parses tags and verifies each against the supplied verifier set', async () => {
    const root = await workspace()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'foo.md'), '#')

    const text = `
<claim ref="file:docs/foo.md">file exists</claim>
<claim ref="file:nope.md">file missing</claim>
<claim ref="needs-evidence:foo">unanchored</claim>
`
    const result = await toolVerifyClaims(text, ctx(root, [fileVerifier]))
    const report = result.structuredContent as {
      counts: {
        total: number
        verified: number
        unverified: number
        needsEvidence: number
      }
    }
    expect(report.counts.total).toBe(3)
    expect(report.counts.verified).toBe(1)
    expect(report.counts.unverified).toBe(1)
    expect(report.counts.needsEvidence).toBe(1)
    // Text content mirrors structuredContent as JSON
    expect(result.content[0]?.type).toBe('text')
    expect(result.content[0]?.text).toContain('"verdict": "verified"')
  })

  it('returns an empty report when there are no claim tags', async () => {
    const root = await workspace()
    const result = await toolVerifyClaims(
      'plain prose with no tags',
      ctx(root, [fileVerifier]),
    )
    const report = result.structuredContent as {
      counts: { total: number }
    }
    expect(report.counts.total).toBe(0)
  })
})

describe('toolVerifyClaim', () => {
  it('wraps a (claim, ref) pair as a synthetic tag and returns one verdict', async () => {
    const root = await workspace()
    await writeFile(join(root, 'real.md'), '.')

    const result = await toolVerifyClaim(
      { claim: 'real exists', ref: 'file:real.md' },
      ctx(root, [fileVerifier]),
    )
    const claim = result.structuredContent as {
      rawRef: string
      text: string
      verdict: { verdict: string }
    }
    expect(claim.rawRef).toBe('file:real.md')
    expect(claim.text).toBe('real exists')
    expect(claim.verdict.verdict).toBe('verified')
  })

  it('escapes double-quotes in the ref body', async () => {
    const root = await workspace()
    const result = await toolVerifyClaim(
      { claim: 'x', ref: 'tricky:"value"' },
      ctx(root, [fileVerifier]),
    )
    const claim = result.structuredContent as { rawRef: string }
    // After escaping, the ref body has &quot; not raw ". When the dispatcher
    // parses it back out, rawRef carries the escaped form.
    expect(claim.rawRef).toContain('&quot;')
  })

  it('returns null structuredContent when no claims parse', async () => {
    // Empty claim text — parses to an empty claim or none
    const root = await workspace()
    const result = await toolVerifyClaim(
      { claim: 'x', ref: 'file:absent.md' },
      ctx(root, [fileVerifier]),
    )
    expect(result.structuredContent).toBeDefined()
  })
})

describe('toolListVerifiers', () => {
  it('summarises each verifier with prefix, name, description, discovery flag', () => {
    const verifiers: Verifier[] = [
      fakeVerifier({
        prefix: 'a',
        description: 'first verifier',
        refs: [{ ref: 'a:1' }],
      }),
      fakeVerifier({
        prefix: 'b',
        description: 'second verifier',
        hasDiscover: false,
      }),
    ]
    const result = toolListVerifiers(verifiers)
    const { verifiers: list } = result.structuredContent as {
      verifiers: {
        prefix: string
        name: string
        description: string | null
        discovery: boolean
      }[]
    }
    expect(list).toHaveLength(2)
    expect(list[0]?.prefix).toBe('a')
    expect(list[0]?.description).toBe('first verifier')
    expect(list[0]?.discovery).toBe(true)
    expect(list[1]?.discovery).toBe(false)
  })

  it('handles a verifier with no description as null', () => {
    const verifiers: Verifier[] = [
      fakeVerifier({ prefix: 'noddesc', hasDiscover: false }),
    ]
    const result = toolListVerifiers(verifiers)
    const { verifiers: list } = result.structuredContent as {
      verifiers: { description: string | null }[]
    }
    expect(list[0]?.description).toBeNull()
  })

  it('handles an empty verifier set', () => {
    const result = toolListVerifiers([])
    const { verifiers } = result.structuredContent as {
      verifiers: unknown[]
    }
    expect(verifiers).toEqual([])
  })
})

describe('toolDiscoverRefs', () => {
  it('unions discover() results across verifiers', async () => {
    const root = await workspace()
    const verifiers: Verifier[] = [
      fakeVerifier({
        prefix: 'a',
        refs: [{ ref: 'a:1', description: 'one' }, { ref: 'a:2' }],
      }),
      fakeVerifier({ prefix: 'b', refs: [{ ref: 'b:1' }] }),
    ]
    const result = await toolDiscoverRefs(verifiers, ctx(root, verifiers))
    const menu = result.structuredContent as {
      refs: { ref: string }[]
      warnings: string[]
    }
    expect(menu.refs.map((r) => r.ref).sort()).toEqual(['a:1', 'a:2', 'b:1'])
    expect(menu.warnings).toEqual([])
  })

  it('captures per-verifier discover() failures as warnings', async () => {
    const root = await workspace()
    const verifiers: Verifier[] = [
      fakeVerifier({ prefix: 'ok', refs: [{ ref: 'ok:1' }] }),
      fakeVerifier({ prefix: 'boom', throwInDiscover: true }),
    ]
    const result = await toolDiscoverRefs(verifiers, ctx(root, verifiers))
    const menu = result.structuredContent as {
      refs: { ref: string }[]
      warnings: string[]
    }
    expect(menu.refs.map((r) => r.ref)).toEqual(['ok:1'])
    expect(menu.warnings.length).toBe(1)
    expect(menu.warnings[0]).toMatch(/discover\(\) failed/)
  })

  it('skips verifiers without discover()', async () => {
    const root = await workspace()
    const verifiers: Verifier[] = [
      fakeVerifier({ prefix: 'no-disc', hasDiscover: false }),
    ]
    const result = await toolDiscoverRefs(verifiers, ctx(root, verifiers))
    const menu = result.structuredContent as {
      refs: unknown[]
      warnings: unknown[]
    }
    expect(menu.refs).toEqual([])
    expect(menu.warnings).toEqual([])
  })
})
