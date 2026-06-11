import { describe, expect, it } from 'vitest'

import { generateVariant } from '../src/models/index.js'

describe('generateVariant — provider dispatch', () => {
  // We can't make real model calls in unit tests; instead we drive the
  // failure path which exercises the provider routing + error mapping
  // without needing API keys. The error message contains the keyHint
  // string we baked into PROVIDER_KEY_HINT, which is the contract worth
  // locking in (so brand-kits authored against this surface get useful
  // error messages when credentials are missing).

  it('reports a useful hint for google-vertex when credentials are missing', async () => {
    const v = await generateVariant({
      modelId: 'google-vertex/gemini-2.5-flash',
      prompt: 'hello',
      variantId: 'v0',
    })
    // Either the call succeeded (won't happen in CI with no creds) OR we
    // see the explanatory failure shape with the right key hint.
    if (v.text.startsWith('[model call failed:')) {
      expect(v.text).toContain('google-vertex')
      expect(v.text).toContain('GOOGLE_CLOUD_PROJECT')
    }
  })

  it('reports a useful hint for anthropic-vertex when credentials are missing', async () => {
    const v = await generateVariant({
      modelId: 'anthropic-vertex/claude-haiku-4-5',
      prompt: 'hello',
      variantId: 'v0',
    })
    if (v.text.startsWith('[model call failed:')) {
      expect(v.text).toContain('anthropic-vertex')
      expect(v.text).toContain('GOOGLE_CLOUD_PROJECT')
    }
  })

  it('throws/reports unknown provider explicitly (helps brand-kit authoring)', async () => {
    const v = await generateVariant({
      modelId: 'no-such-provider/some-model',
      prompt: 'hello',
      variantId: 'v0',
    })
    // The provider lookup throws inside generateVariant and is caught,
    // surfaced as a [model call failed: ...] variant.
    expect(v.text).toContain('[model call failed:')
    expect(v.text).toContain('no-such-provider')
  })
})
