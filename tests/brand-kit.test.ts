import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadBrandKit, brandKitSchema } from '../src/brand-kit.js'

const MINIMAL_VALID = {
  name: 'test-brand',
  version: '0.1.0',
  canonicals: {
    marketing: {
      spec: 'docs/brand/CANONICAL.md',
    },
  },
  models: {
    candidates: ['google/gemini-1.5-pro'],
    grader: 'anthropic/claude-3-5-sonnet-latest',
  },
}

describe('brandKitSchema', () => {
  it('parses a minimal valid brand-kit', () => {
    const result = brandKitSchema.safeParse(MINIMAL_VALID)
    expect(result.success).toBe(true)
  })

  it('rejects a brand-kit missing required fields', () => {
    const result = brandKitSchema.safeParse({
      name: 'test',
      // missing version, canonicals, models
    })
    expect(result.success).toBe(false)
  })

  it('rejects a brand-kit with empty candidate list', () => {
    const result = brandKitSchema.safeParse({
      ...MINIMAL_VALID,
      models: { ...MINIMAL_VALID.models, candidates: [] },
    })
    expect(result.success).toBe(false)
  })

  it('validates destination entries', () => {
    const result = brandKitSchema.safeParse({
      ...MINIMAL_VALID,
      destinations: {
        entries: {
          scratch: {
            adapter: 'output-file',
            config: { path: '/tmp/out.md' },
          },
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects a destination entry with an empty adapter string', () => {
    const result = brandKitSchema.safeParse({
      ...MINIMAL_VALID,
      destinations: {
        entries: {
          scratch: { adapter: '', config: {} },
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it('accepts corpus entries with status field', () => {
    const result = brandKitSchema.safeParse({
      ...MINIMAL_VALID,
      corpora: {
        voice: {
          backend: 'pgvector',
          index_name: 'voice',
          status: 'deferred',
        },
      },
    })
    expect(result.success).toBe(true)
  })
})

describe('loadBrandKit', () => {
  it('loads + validates a brand-kit from an explicit path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brand-kit-test-'))
    const path = join(dir, 'brand-kit.json')
    await writeFile(path, JSON.stringify(MINIMAL_VALID, null, 2), 'utf-8')

    const kit = await loadBrandKit(path)
    expect(kit.name).toBe('test-brand')
    expect(kit.models.candidates).toEqual(['google/gemini-1.5-pro'])
  })

  it('throws on missing brand-kit file', async () => {
    await expect(
      loadBrandKit('/nonexistent/path/brand-kit.json'),
    ).rejects.toThrow()
  })

  it('throws with a useful message on malformed brand-kit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brand-kit-test-'))
    const path = join(dir, 'brand-kit.json')
    await writeFile(path, JSON.stringify({ name: 'no-models' }), 'utf-8')

    await expect(loadBrandKit(path)).rejects.toThrow(/failed validation/)
  })
})
