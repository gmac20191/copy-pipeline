import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BrandKit } from '../src/brand-kit.js'
import {
  _clearInputSourceRegistry,
  INPUT_SOURCE_REGISTRY,
  registerInputSource,
  defaultInputSources,
  type BriefEvent,
  type BriefSource,
} from '../src/source/index.js'

function fakeSource(opts: {
  name: string
  events?: BriefEvent[]
  description?: string
}): BriefSource {
  return {
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    async *watch() {
      for (const e of opts.events ?? []) yield e
    },
  }
}

function brandKit(): BrandKit {
  return {
    name: 'test',
    version: '0.1.0',
    canonicals: { marketing: { spec: 'docs/brand/CANONICAL.md' } },
    corpora: {},
    models: { candidates: ['x/y'], grader: 'x/y' },
  }
}

beforeEach(() => _clearInputSourceRegistry())
afterEach(() => _clearInputSourceRegistry())

describe('INPUT_SOURCE_REGISTRY', () => {
  it('registers and looks up sources by name', () => {
    const s = fakeSource({ name: 'drive' })
    registerInputSource(s)
    expect(INPUT_SOURCE_REGISTRY.size).toBe(1)
    expect(INPUT_SOURCE_REGISTRY.get('drive')?.name).toBe('drive')
  })

  it('throws on duplicate name', () => {
    const a = fakeSource({ name: 'dup', description: 'first' })
    const b = fakeSource({ name: 'dup', description: 'second' })
    registerInputSource(a)
    expect(() => registerInputSource(b)).toThrow(/Duplicate input source/)
  })

  it('defaultInputSources is empty in v1', async () => {
    expect(await defaultInputSources()).toEqual([])
  })
})

describe('BriefSource.watch contract', () => {
  it('yields BriefEvents from an async iterable', async () => {
    const events: BriefEvent[] = [
      {
        id: 'doc1',
        brief: { text: 'transform me' },
        sourceDocument: 'original body',
        metadata: { sourcePath: '/folder/doc1.gdoc' },
      },
      {
        id: 'doc2',
        brief: { text: 'transform me' },
        sourceDocument: 'another body',
        metadata: {},
      },
    ]
    const src = fakeSource({ name: 'fake', events })

    const collected: BriefEvent[] = []
    for await (const e of src.watch({
      config: {},
      ctx: { workspaceRoot: '/tmp', brandKit: brandKit() },
    })) {
      collected.push(e)
    }
    expect(collected).toHaveLength(2)
    expect(collected[0]?.id).toBe('doc1')
    expect(collected[1]?.sourceDocument).toBe('another body')
  })

  it('a source with no events terminates cleanly', async () => {
    const src = fakeSource({ name: 'empty' })
    const collected: BriefEvent[] = []
    for await (const e of src.watch({
      config: {},
      ctx: { workspaceRoot: '/tmp', brandKit: brandKit() },
    })) {
      collected.push(e)
    }
    expect(collected).toEqual([])
  })
})
