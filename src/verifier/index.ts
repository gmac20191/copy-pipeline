/**
 * Verifier interface.
 *
 * Verifiers resolve product-behaviour Claims tagged in a Variant against a
 * source of truth (eval scenarios, ADRs, code symbols, NotebookLM corpus,
 * etc.). Verification is per-Claim and semantically distinct from Grading,
 * which scores whole Variants.
 *
 * Sibling registry to Grader / GroundingSource / DestinationAdapter.
 *
 * V1 ships generic verifiers in `src/verifier/{name}.ts`:
 * - `file` — checks a file path exists in the workspace
 *
 * Consumer projects register project-specific verifiers at startup via
 * `registerVerifier()` (e.g. `eval-scenario`, `snapshot`, `feature-flag`,
 * `confluence-page`).
 *
 * See ADR `docs/adr/0002-claim-verification.md`.
 */

import type { BrandKit } from '../types.js'

/** Typed-string evidence reference. Format `<prefix>:<body>`. */
export type EvidenceRef = string

export interface VerifierContext {
  /** Absolute path to the consumer project root. */
  workspaceRoot: string
  brandKit: BrandKit
}

export interface VerifyArgs {
  /** The prose inside the `<claim>` tag. */
  claim: string
  /** The ref body, after the prefix. e.g. `stress-driver-fcq-down`. */
  ref: string
  /** The full ref including prefix. e.g. `eval:stress-driver-fcq-down`. */
  rawRef: EvidenceRef
}

/**
 * A Verifier's verdict for a single Claim.
 *
 * - `verified` — evidence exists and supports the claim
 * - `unverified` — evidence is missing or contradicts the claim (block at gate)
 * - `error` — couldn't check (transient / network / IO) — caller decides
 *
 * Every variant may carry an optional `trace` — verifier-specific provenance
 * captured during the run (the query sent, the corpus response, the judge's
 * rationale, etc.). The dispatcher does not interpret `trace`; consumers that
 * want auditable verification (e.g. publishing a public source page) read it
 * directly. Shape is verifier-defined — document it in each verifier's
 * module-level comment.
 */
export type VerifyResult =
  | {
      verdict: 'verified'
      source: { uri: string; lastConfirmed?: string }
      supporting?: string
      confidence?: number
      trace?: unknown
    }
  | {
      verdict: 'unverified'
      reason: string
      hint?: string
      trace?: unknown
    }
  | {
      verdict: 'error'
      message: string
      trace?: unknown
    }

export interface DiscoveredRef {
  /** Full ref including prefix, e.g. `adr:0002-claim-verification`. */
  ref: EvidenceRef
  /** Human-readable hint surfaced to the ClaimExtractor LLM. */
  description?: string
  /** Verifier-specific metadata (lastConfirmed, status, etc.). */
  metadata?: Record<string, unknown>
}

/** A function that registers a Verifier with the global registry.
 * Consumers that ship a plugin pack typically expose a `registerAll` helper
 * taking one of these so they don't need to import the entire core API. */
export type RegisterVerifierFn = (v: Verifier) => void

export interface Verifier {
  /** Routing key. One Verifier per prefix. e.g. `eval`, `adr`, `file`. */
  prefix: string
  /** Stable identifier; surfaced in reports and traces. */
  name: string
  /** Human description. */
  description?: string
  verify(args: VerifyArgs, ctx: VerifierContext): Promise<VerifyResult>
  /**
   * Optional. Enumerates the Verifier's current valid Evidence refs for the
   * ClaimExtractor's proposal menu. Bounded ref-spaces (eval scenarios,
   * ADRs, files) implement this; unbounded ones (corpus queries, web
   * search) skip it and accept arbitrary refs at verify time.
   */
  discover?(ctx: VerifierContext): Promise<DiscoveredRef[]>
}

/**
 * Reserved prefix the ClaimExtractor uses when no Evidence ref could be
 * proposed. Never has a registered Verifier — the dispatcher handles it.
 */
export const NEEDS_EVIDENCE_PREFIX = 'needs-evidence'

export const VERIFIER_REGISTRY = new Map<string, Verifier>()

/**
 * Register a Verifier. Throws if a Verifier is already registered for the
 * same prefix — fail-fast to surface conflicts at startup, not at verify
 * time. Use a sub-prefix (e.g. `eval-app`, `eval-docs`) if you ever
 * legitimately need multiple verifiers per logical type.
 */
export function registerVerifier(v: Verifier): void {
  if (v.prefix === NEEDS_EVIDENCE_PREFIX) {
    throw new Error(
      `Cannot register verifier for reserved prefix '${NEEDS_EVIDENCE_PREFIX}'`,
    )
  }
  if (VERIFIER_REGISTRY.has(v.prefix)) {
    const existing = VERIFIER_REGISTRY.get(v.prefix)!
    throw new Error(
      `Duplicate verifier for prefix '${v.prefix}': existing='${existing.name}', new='${v.name}'`,
    )
  }
  VERIFIER_REGISTRY.set(v.prefix, v)
}

export function getVerifierForRef(ref: EvidenceRef): Verifier | undefined {
  const idx = ref.indexOf(':')
  if (idx === -1) return undefined
  const prefix = ref.slice(0, idx)
  return VERIFIER_REGISTRY.get(prefix)
}

/**
 * Test/teardown helper. Clears the registry. Not part of the public API
 * contract — exported only for test isolation.
 */
export function _clearVerifierRegistry(): void {
  VERIFIER_REGISTRY.clear()
}

/**
 * Default Verifier roster. V1 ships only the brand-agnostic `file`
 * verifier. Consumers register their project-specific verifiers at
 * startup. Pass a custom array via the dispatcher's `verifiers` option
 * to override entirely.
 */
export async function defaultVerifiers(): Promise<Verifier[]> {
  const { fileVerifier } = await import('./file.js')
  return [fileVerifier]
}
