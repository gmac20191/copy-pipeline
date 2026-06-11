import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  recordPick,
  type PickRecorder,
  type PickArgs,
  type PickResult,
} from '../src/pick.js'

const ENV_PUBLIC = 'LANGFUSE_PUBLIC_KEY'
const ENV_SECRET = 'LANGFUSE_SECRET_KEY'

let origPub: string | undefined
let origSec: string | undefined

beforeEach(() => {
  origPub = process.env[ENV_PUBLIC]
  origSec = process.env[ENV_SECRET]
  delete process.env[ENV_PUBLIC]
  delete process.env[ENV_SECRET]
})
afterEach(() => {
  if (origPub === undefined) delete process.env[ENV_PUBLIC]
  else process.env[ENV_PUBLIC] = origPub
  if (origSec === undefined) delete process.env[ENV_SECRET]
  else process.env[ENV_SECRET] = origSec
})

function stub(result: PickResult): { fn: PickRecorder; called: PickArgs[] } {
  const called: PickArgs[] = []
  const fn: PickRecorder = async (args) => {
    called.push(args)
    return result
  }
  return { fn, called }
}

describe('recordPick', () => {
  it('returns ok=false with reason when runId is missing', async () => {
    const { fn, called } = stub({ ok: true })
    const result = await recordPick({ runId: '', variantId: 'v1' }, fn)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/runId/)
    expect(called).toEqual([])
  })

  it('returns ok=false with reason when variantId is missing', async () => {
    const { fn, called } = stub({ ok: true })
    const result = await recordPick({ runId: 'r1', variantId: '' }, fn)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/variantId/)
    expect(called).toEqual([])
  })

  it('delegates to the recorder when args are valid', async () => {
    const { fn, called } = stub({ ok: true })
    const result = await recordPick(
      { runId: 'r1', variantId: 'v1', edits: 'shipped copy' },
      fn,
    )
    expect(result.ok).toBe(true)
    expect(called).toEqual([
      { runId: 'r1', variantId: 'v1', edits: 'shipped copy' },
    ])
  })

  it('passes through the recorder result on failure', async () => {
    const { fn } = stub({ ok: false, reason: 'simulated transport error' })
    const result = await recordPick({ runId: 'r1', variantId: 'v1' }, fn)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('simulated transport error')
  })

  it('default recorder returns ok=false when Langfuse env is missing', async () => {
    // No env set in beforeEach. Default recorder runs.
    const result = await recordPick({ runId: 'r1', variantId: 'v1' })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/Langfuse not configured/)
  })
})
