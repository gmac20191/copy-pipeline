/**
 * Core shared types for copy-pipeline.
 *
 * Architecture rationale lives in the consuming project's ADR
 * (`docs/decisions/<date>-copy-pipeline-architecture.md`).
 */

import type { BrandKit } from './brand-kit.js'

// Re-exported so consumers can import the central types from "./types.js"
// without needing a second import for BrandKit.
export type { BrandKit }

export type ModelId = string // e.g. "google/gemini-3.1-pro"

/**
 * One operator-supplied generation request.
 */
export interface Brief {
  /** 1-3 sentence operator description of what to write. */
  text: string
  /** Named corpus handles to ground retrieval against (e.g. ["voice","science"]). */
  ground?: string[]
  /** Optional override of brand-kit's default candidate set. */
  models?: ModelId[]
  /** Optional override of brand-kit's default N (number of variants). */
  n?: number
}

/**
 * One variant produced for a brief.
 */
export interface Variant {
  id: string
  model: ModelId
  text: string
  /** Tokens consumed; absent if the model adapter doesn't report. */
  tokens?: { prompt: number; completion: number }
  /** Wall-clock latency ms. */
  latencyMs?: number
}

/**
 * One severity-tagged finding emitted by a grader.
 */
export interface Finding {
  graderName: string
  severity: 'blocker' | 'warning' | 'suggestion'
  message: string
  /** Free-form per-grader detail (rule id, judge dim score, etc.). */
  detail?: Record<string, unknown>
}

/**
 * A variant after all graders have run.
 */
export interface GradedVariant {
  variant: Variant
  findings: Finding[]
  /** Composite score, higher = better. Per-pipeline scoring formula. */
  score: number
}

/**
 * A retrieved chunk from a grounding source.
 */
export interface GroundingChunk {
  source: string // e.g. "voice", "science"
  backend: string // e.g. "pgvector"
  text: string
  metadata?: Record<string, unknown>
}

/**
 * Result of one `generate()` call.
 */
export interface GenerationRun {
  runId: string
  brief: Brief
  brandKit: BrandKit
  groundingChunks: GroundingChunk[]
  graded: GradedVariant[]
  /** Set when the operator picks a variant (post-run). */
  pick?: {
    variantId: string
    edits?: string
    pickedAt: Date
  }
}

/**
 * Options to `generate()`. Mostly mirrors Brief but allows pipeline-level overrides.
 */
export interface GenerateOptions {
  brief: Brief
  brandKit: BrandKit
  /** Optional Langfuse trace ID override. Defaults to a new ID per run. */
  traceId?: string
  /**
   * Override the default grader stack. When omitted, `defaultGraders()` is
   * used (brand-review in v0.1; brand-review + LLM voice judge in v0.2).
   */
  graders?: import('./grader/index.js').Grader[]
  /**
   * When set, generation runs in TRANSFORM mode: the model is asked to
   * improve `sourceDocument` per the brief.text instruction rather than
   * generate new content from scratch. This is the shape that BriefSource
   * adapters (e.g. google-drive folder watcher) use when surfacing an
   * existing document for the pipeline to rewrite through the brand
   * canonical.
   *
   * When omitted, generation runs in the original GENERATE mode (brief
   * describes what to write; model writes from scratch).
   */
  sourceDocument?: string
}
