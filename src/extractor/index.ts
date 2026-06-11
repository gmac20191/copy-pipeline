/**
 * ClaimExtractor interface.
 *
 * Extractors scan a Variant for product-behaviour claims, propose
 * Evidence refs from the union of registered Verifiers' `discover()`
 * outputs, and emit the variant text with `<claim ref="...">` tags
 * inserted. Default flow is LLM-driven; the same interface supports
 * deterministic or keyword-based extractors.
 *
 * Sibling registry to Grader / GroundingSource / Verifier / Destination.
 *
 * V1 ships:
 * - `llm-extractor` — uses brandKit.models.grader via ai-sdk
 *
 * See ADR `docs/adr/0002-claim-verification.md`.
 */

import type { BrandKit, Variant } from '../types.js'
import type { EvidenceRef, Verifier } from '../verifier/index.js'

export interface ClaimExtractorContext {
  brandKit: BrandKit
  /** Absolute path to the consumer project root. */
  workspaceRoot: string
  /** Verifiers whose discover() composes the proposal menu. */
  verifiers: Verifier[]
  /** The brief that produced the variants (for LLM context). */
  briefText: string
}

/** One claim the extractor identified. Pre-wrapping. */
export interface ExtractedClaim {
  /** Verbatim prose from the variant. */
  text: string
  /** Proposed Evidence ref. Either a known prefix:body or `needs-evidence`. */
  ref: EvidenceRef
  /** Optional brief reason for the chosen ref. */
  reasoning?: string
}

export interface ExtractionResult {
  /** Variant text with <claim> tags inserted around extracted claims. */
  text: string
  /** Claims the extractor identified, before wrapping. */
  extracted: ExtractedClaim[]
  /** Soft errors: claim text not found, ref unknown to verifier set, etc. */
  warnings: string[]
  /** Tokens consumed by the LLM call (when applicable). */
  tokens?: { prompt: number; completion: number }
  /** Wall-clock latency ms. */
  latencyMs?: number
}

export interface ClaimExtractor {
  /** Stable identifier; surfaced in traces and reports. */
  name: string
  description?: string
  extract(
    variant: Variant,
    ctx: ClaimExtractorContext,
  ): Promise<ExtractionResult>
}

export const EXTRACTOR_REGISTRY = new Map<string, ClaimExtractor>()

export function registerExtractor(e: ClaimExtractor): void {
  if (EXTRACTOR_REGISTRY.has(e.name)) {
    const existing = EXTRACTOR_REGISTRY.get(e.name)!
    throw new Error(
      `Duplicate extractor for name '${e.name}': existing description='${existing.description}'`,
    )
  }
  EXTRACTOR_REGISTRY.set(e.name, e)
}

/** Test/teardown helper. Not part of the public API contract. */
export function _clearExtractorRegistry(): void {
  EXTRACTOR_REGISTRY.clear()
}

/**
 * Default ClaimExtractor roster. V1 ships the LLM-backed extractor using
 * brandKit.models.grader. Consumers can pass a custom array to the
 * pipeline to override entirely.
 */
export async function defaultExtractors(): Promise<ClaimExtractor[]> {
  const { llmClaimExtractor } = await import('./llm.js')
  return [llmClaimExtractor]
}
