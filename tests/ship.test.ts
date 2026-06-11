import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ship } from '../src/ship.js'
import { outputFileDestination } from '../src/destination/output-file.js'
import type { BrandKit } from '../src/brand-kit.js'
import type { DestinationAdapter } from '../src/destination/index.js'

function brandKit(destinations: BrandKit['destinations']): BrandKit {
  return {
    name: 'test',
    version: '0.1.0',
    canonicals: { marketing: { spec: 'docs/brand/CANONICAL.md' } },
    corpora: {},
    models: {
      candidates: ['google/gemini-1.5-pro'],
      grader: 'anthropic/claude-3-5-sonnet-latest',
    },
    destinations,
  }
}

describe('ship()', () => {
  it('writes copy to an output-file destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ship-test-'))
    const outPath = join(dir, 'out.md')

    const result = await ship({
      copy: 'hello world',
      destination: 'scratch',
      brandKit: brandKit({
        entries: {
          scratch: { adapter: 'output-file', config: { path: outPath } },
        },
      }),
      adapters: [outputFileDestination],
    })

    expect(result.ok).toBe(true)
    expect(result.destinationName).toBe('scratch')
    expect(result.adapterName).toBe('output-file')
    expect(await readFile(outPath, 'utf-8')).toBe('hello world')
  })

  it('returns ok=false for an unknown destination key', async () => {
    const result = await ship({
      copy: 'x',
      destination: 'missing',
      brandKit: brandKit({ entries: {} }),
      adapters: [outputFileDestination],
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not declared/)
  })

  it('returns ok=false when the adapter name has no registered impl', async () => {
    const result = await ship({
      copy: 'x',
      destination: 'scratch',
      brandKit: brandKit({
        entries: {
          scratch: { adapter: 'nonexistent-adapter', config: {} },
        },
      }),
      adapters: [outputFileDestination],
    })

    expect(result.ok).toBe(false)
    expect(result.adapterName).toBe('nonexistent-adapter')
    expect(result.error).toMatch(/no DestinationAdapter registered/)
  })

  it('output-file rejects invalid config', async () => {
    const result = await ship({
      copy: 'x',
      destination: 'bad',
      brandKit: brandKit({
        entries: {
          bad: {
            adapter: 'output-file',
            config: {} as Record<string, unknown>,
          },
        },
      }),
      adapters: [outputFileDestination],
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/invalid config/)
  })

  it('dispatches to a custom adapter via the adapters override', async () => {
    let receivedCopy = ''
    const stub: DestinationAdapter = {
      name: 'noop-stub',
      async publish({ copy, targetName }) {
        receivedCopy = copy
        return {
          ok: true,
          destinationName: targetName,
          adapterName: 'noop-stub',
          detail: 'echoed',
        }
      },
    }

    const result = await ship({
      copy: 'from-test',
      destination: 'noop',
      brandKit: brandKit({
        entries: { noop: { adapter: 'noop-stub', config: {} } },
      }),
      adapters: [stub],
    })

    expect(result.ok).toBe(true)
    expect(receivedCopy).toBe('from-test')
  })
})
