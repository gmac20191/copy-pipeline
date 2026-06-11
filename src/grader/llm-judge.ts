/**
 * LLM voice judge grader.
 *
 * Scores each variant against the brand canonical's voice rules on four
 * dimensions (1-5 each). Uses the brand-kit's declared grader model —
 * MUST be a distinct checkpoint from any variant-generating candidate to
 * avoid self-judging bias. Different-tier-same-family (e.g. Claude Sonnet
 * grading a run that includes Claude Opus) is acceptable; same-checkpoint
 * is not.
 *
 * Composite score = average of the four dimensions / 5. Returned as a single
 * "suggestion"-severity Finding so the operator sees the per-dim breakdown
 * without it filtering the variant out.
 *
 * Graceful failure: missing API key, schema-validation failure, network
 * error — each returns a warning finding with score 0.5 (neutral). Pipeline
 * continues; grading is partial-but-honest.
 */

import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { openai } from '@ai-sdk/openai'
import { z } from 'zod'

import type { Grader, GraderContext, GraderResult } from './index.js'
import type { Finding, Variant } from '../types.js'

// ─── Output schema ──────────────────────────────────────────────────────────

const judgeSchema = z.object({
  scores: z.object({
    anchored: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe(
        'Leads with concrete competence — methodologies, specific numbers, audience-tells (RPE / TM / AMRAP / periodisation). 1=generic SaaS copy. 5=domain-fluent, signals expertise immediately.',
      ),
    on_tone: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe(
        'Humble + practical, not dogmatic or preachy. 1="studies prove" / "evidence-based research demonstrates". 5="many people find" / "try this" / "based on your feedback".',
      ),
    audience_calibration: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe(
        "Talks to the reader who already knows the vocabulary. 1=explains what RPE means / hedges with 'whether you're a beginner or seasoned athlete'. 5=trusts the reader, uses domain shorthand freely.",
      ),
    no_companion_leak: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe(
        "Avoids companion-coach / wellness-app / 'reads you like a friend' register. 1=warm, anthropomorphic, 'hey lifter', 'anticipates what you'd do'. 5=instrumental tool voice, no chumminess.",
      ),
  }),
  rationale: z
    .string()
    .describe(
      '2-4 sentence explanation of the scores. Cite specific phrases from the variant when possible.',
    ),
})

type JudgeOutput = z.infer<typeof judgeSchema>

// ─── Model resolution ───────────────────────────────────────────────────────

function resolveGraderModel(modelId: string) {
  const slash = modelId.indexOf('/')
  if (slash <= 0) {
    throw new Error(
      `invalid grader model id "${modelId}" — expected "provider/name"`,
    )
  }
  const provider = modelId.slice(0, slash)
  const name = modelId.slice(slash + 1)
  switch (provider) {
    case 'anthropic':
      return anthropic(name)
    case 'google':
      return google(name)
    case 'openai':
      return openai(name)
    default:
      throw new Error(
        `unknown grader provider "${provider}" in model id "${modelId}"`,
      )
  }
}

// ─── Prompt ────────────────────────────────────────────────────────────────

function buildJudgePrompt(variant: Variant, ctx: GraderContext): string {
  const { brandKit, briefText } = ctx
  const marketingSpec =
    brandKit.canonicals['marketing']?.spec ?? '(no canonical declared)'

  return `Score the following copy variant against the canonical voice rules for the "${brandKit.name}" brand.

The canonical voice spec lives at \`${marketingSpec}\` and codifies these rules:
- Serious instrument, not companion coach. Strength-athlete reader who knows the vocabulary.
- Lead with concrete competence — methodologies, specific numbers, audience-tells.
- Don't explain domain vocabulary the reader already knows (RPE / TM / AMRAP / periodisation).
- Avoid "studies prove" / "evidence-based research demonstrates" preachy voice. Prefer "many people find" / "try this".
- No companion / wellness register, no marketing cliché, no hedge phrases like "whether you're a beginner or seasoned athlete".
- No "anticipates what you'd do" / "reads you like a coach" voice — instrumental, not emotional.

BRIEF the variant was written against:
${briefText}

VARIANT TEXT to score (produced by ${variant.model}):
"""
${variant.text}
"""

Score each dimension 1-5 (5 = best). Be honest, not generous. Variants that read as model-failure or placeholder text score 1 across the board. Variants that hedge or explain domain vocabulary score low on audience_calibration even if otherwise fluent.`
}

// ─── Grader ────────────────────────────────────────────────────────────────

export const llmVoiceJudgeGrader: Grader = {
  name: 'llm-voice-judge',
  description:
    'LLM-judge scoring on four voice dimensions: anchored, on-tone, audience-calibration, no-companion-leak. Uses brandKit.models.grader (must be distinct from any candidate). Composite score = mean / 5.',

  async grade(variant, ctx): Promise<GraderResult> {
    const graderModelId = ctx.brandKit.models.grader

    try {
      const model = resolveGraderModel(graderModelId)
      const prompt = buildJudgePrompt(variant, ctx)

      const { object } = await generateObject({
        model,
        schema: judgeSchema,
        prompt,
        temperature: 0.2,
      })

      const judgement = object as JudgeOutput
      const { anchored, on_tone, audience_calibration, no_companion_leak } =
        judgement.scores
      const avg =
        (anchored + on_tone + audience_calibration + no_companion_leak) / 4
      const score = avg / 5

      const findings: Finding[] = [
        {
          graderName: 'llm-voice-judge',
          severity: 'suggestion',
          message:
            `voice scores: anchored=${anchored}/5, on-tone=${on_tone}/5, ` +
            `audience-calibration=${audience_calibration}/5, ` +
            `no-companion-leak=${no_companion_leak}/5. ${judgement.rationale}`,
          detail: { ...judgement, grader_model: graderModelId },
        },
      ]

      return { findings, score }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      return {
        findings: [
          {
            graderName: 'llm-voice-judge',
            severity: 'warning',
            message:
              `LLM judge invocation failed (grader=${graderModelId}): ${msg}. ` +
              `Likely cause: missing API key for the grader's provider.`,
          },
        ],
        score: 0.5,
      }
    }
  },
}
