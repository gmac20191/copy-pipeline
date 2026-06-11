/**
 * Example Verifier — template to copy when adding a new evidence type.
 *
 * This one verifies the literal claim text against a hardcoded allowlist
 * (the kind of thing you'd never ship; it's here as the smallest possible
 * Verifier implementation showing the contract).
 *
 * To adapt:
 *   1. Rename file + symbol to match the evidence type (e.g. feature-flag.ts,
 *      jira-ticket.ts, code-symbol.ts).
 *   2. Set `prefix` to the routing key authors will use in
 *      <claim ref="prefix:body">…</claim>.
 *   3. Replace the body of `verify()` with the actual existence + correctness
 *      check against your source of truth.
 *   4. Implement `discover()` if your evidence space is enumerable (returns
 *      DiscoveredRef[] for the ClaimExtractor LLM menu). Skip for unbounded
 *      spaces (corpus queries, free-form refs).
 *   5. Export the verifier from index.ts and add to `consumerVerifiers`.
 *   6. Add a vitest file alongside covering the verify + discover paths.
 */

import type {
  DiscoveredRef,
  Verifier,
  VerifyArgs,
  VerifyResult,
} from '@gmac20191/copy-pipeline'

const ALLOWLIST = new Set(['alpha', 'beta', 'gamma'])

async function verify(args: VerifyArgs): Promise<VerifyResult> {
  if (!args.ref) {
    return {
      verdict: 'unverified',
      reason: 'empty ref body',
      hint: 'expected one of: alpha | beta | gamma',
    }
  }
  if (ALLOWLIST.has(args.ref)) {
    return {
      verdict: 'verified',
      source: { uri: `example://${args.ref}` },
    }
  }
  return {
    verdict: 'unverified',
    reason: `'${args.ref}' is not in the example allowlist`,
    hint: `valid refs: ${[...ALLOWLIST].sort().join(', ')}`,
  }
}

async function discover(): Promise<DiscoveredRef[]> {
  return [...ALLOWLIST].sort().map((id) => ({
    ref: `example:${id}`,
    description: `example evidence id ${id}`,
  }))
}

export const exampleVerifier: Verifier = {
  prefix: 'example',
  name: 'consumer-example',
  description:
    'Template Verifier — replace with a real evidence check against your source of truth.',
  verify,
  discover,
}
