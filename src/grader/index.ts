/**
 * Grader interface.
 *
 * Concrete graders ship in `src/grader/{name}.ts`. Each implements `grade()`
 * against one variant + generation context. V1 ships with:
 *
 * - `brand-review` — deterministic rule checks (shells out to brand-review skill)
 * - `llm-voice-judge` — LLM judge for voice nuance (model from brand-kit.models.grader)
 *
 * Sibling use cases (tech-doc generation, eval-rubric drafting) plug in additional
 * grader implementations via the same interface. See ADR
 * `docs/decisions/2026-05-19-copy-pipeline-architecture.md` "Future sibling use cases".
 */

import type { BrandKit, Variant, Finding } from '../types.js'

export interface GraderContext {
  brandKit: BrandKit
  /** Other variants in the same run (for relative scoring if a grader cares). */
  siblings: Variant[]
  /** The brief that produced these variants. */
  briefText: string
}

export interface GraderResult {
  findings: Finding[]
  /** Per-grader score 0..1. Composite score is computed by the pipeline. */
  score: number
}

export interface Grader {
  /** Stable identifier; used in Langfuse trace metadata + Finding.graderName. */
  name: string
  /** Human description. */
  description?: string
  grade(variant: Variant, ctx: GraderContext): Promise<GraderResult>
}

/**
 * Default registry of grader implementations the pipeline knows about. V1 stubs
 * register against this map; future plug-ins (tech-doc verifiers, etc.) add
 * additional entries here or via a `registerGrader()` helper.
 */
export const GRADER_REGISTRY = new Map<string, Grader>()

export function registerGrader(g: Grader): void {
  GRADER_REGISTRY.set(g.name, g)
}

/**
 * Default grader stack returned by `defaultGraders()`. V0.1.0-alpha.3 ships
 * brand-review (deterministic) + LLM voice judge (model from brand-kit.models.grader).
 * Pass a custom array to `generate({ graders: ... })` to override.
 */
export async function defaultGraders(): Promise<Grader[]> {
  // Lazy imports so consumers passing their own graders don't pay for module load.
  const { brandReviewGrader } = await import('./brand-review.js')
  const { llmVoiceJudgeGrader } = await import('./llm-judge.js')

  return [brandReviewGrader, llmVoiceJudgeGrader]
}
