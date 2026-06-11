/**
 * LLM-backed claim extractor (default).
 *
 * Uses brandKit.models.grader (the same model that runs the voice judge)
 * to identify product-behaviour claims in a Variant and propose Evidence
 * refs from the discovery menu. Returns the variant text with `<claim>`
 * tags inserted.
 *
 * The LLM call is factored as an injectable function so tests can stub
 * it without going through the AI SDK or needing API keys.
 *
 * Graceful failure: if the LLM call fails (missing API key, network,
 * schema validation), the extractor returns the variant text unchanged
 * with a single warning. The pipeline continues; the variant just has
 * no tagged claims.
 */

import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { openai } from '@ai-sdk/openai'
import { z } from 'zod'

import type { ModelId, Variant } from '../types.js'
import type {
  ClaimExtractor,
  ClaimExtractorContext,
  ExtractedClaim,
  ExtractionResult,
} from './index.js'
import { buildDiscoveryMenu, renderMenu } from './menu.js'
import { wrapClaims } from './wrap.js'

// ─── Output schema ──────────────────────────────────────────────────────────

const extractionSchema = z.object({
  claims: z.array(
    z.object({
      text: z
        .string()
        .describe(
          'The verbatim prose to tag. Copy character-for-character from the input — do not paraphrase or summarise.',
        ),
      ref: z
        .string()
        .describe(
          'The proposed Evidence ref formatted as "prefix:body". Use one of the entries from the menu when possible. If no menu entry matches, use the literal string "needs-evidence" (without colon).',
        ),
      reasoning: z
        .string()
        .optional()
        .describe('Brief one-sentence justification for the chosen ref.'),
    }),
  ),
})

// ─── Model resolution ───────────────────────────────────────────────────────

function resolveModel(modelId: ModelId) {
  const slash = modelId.indexOf('/')
  if (slash <= 0) {
    throw new Error(
      `invalid extractor model id "${modelId}" — expected "provider/name"`,
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
        `unknown extractor provider "${provider}" in model id "${modelId}"`,
      )
  }
}

// ─── Prompt ────────────────────────────────────────────────────────────────

export function buildExtractorPrompt(args: {
  variant: Variant
  ctx: ClaimExtractorContext
  menuText: string
}): string {
  const { variant, ctx, menuText } = args
  return `You are tagging product-behaviour claims in a piece of copy.

A "product-behaviour claim" is a verifiable assertion about how a specific product behaves, what feature it has, or what it can do. Examples:
- ✓ "Acme auto-detects performance regressions and rolls back the deploy" (specific product behaviour)
- ✓ "Acme remembers your preferences across sessions" (specific feature)
- ✗ "Cloud infrastructure improves application reliability" (general industry claim, not product-specific behaviour)
- ✗ "We built this because developers deserve better tools" (motivation, not behaviour)
- ✗ "Our team has decades of experience" (about the company, not the product)

For each product-behaviour claim you find:
1. Copy the exact prose VERBATIM — character-for-character, no paraphrasing.
2. Choose an Evidence ref from the menu below.
3. If no menu entry plausibly matches, use the literal string "needs-evidence" (without colon).

Be conservative. If a sentence is general / aspirational / about motivation rather than specific product behaviour, do NOT tag it. Better to miss a borderline claim than to invent one.

═══════════════════════════════════════════════════════════
AVAILABLE EVIDENCE REFERENCES
═══════════════════════════════════════════════════════════
${menuText}

═══════════════════════════════════════════════════════════
CONTEXT
═══════════════════════════════════════════════════════════
Brand: ${ctx.brandKit.name}
Brief that produced this copy:
${ctx.briefText}

═══════════════════════════════════════════════════════════
INPUT COPY (produced by ${variant.model})
═══════════════════════════════════════════════════════════
"""
${variant.text}
"""

Return a JSON object matching the schema: { claims: [{ text, ref, reasoning? }] }. Emit zero claims if the copy contains no product-behaviour assertions.`
}

// ─── Injectable LLM call ────────────────────────────────────────────────────

export interface LLMExtractorCallArgs {
  modelId: ModelId
  prompt: string
}

export interface LLMExtractorCallResult {
  claims: ExtractedClaim[]
  tokens?: { prompt: number; completion: number }
}

export type LLMExtractorCall = (
  args: LLMExtractorCallArgs,
) => Promise<LLMExtractorCallResult>

const defaultLLMCall: LLMExtractorCall = async ({ modelId, prompt }) => {
  const model = resolveModel(modelId)
  const { object, usage } = await generateObject({
    model,
    schema: extractionSchema,
    prompt,
    temperature: 0.1,
  })

  // Strip undefined reasoning so optional-property contracts stay clean
  // under exactOptionalPropertyTypes.
  const claims: ExtractedClaim[] = object.claims.map((c) => {
    const claim: ExtractedClaim = { text: c.text, ref: c.ref }
    if (c.reasoning !== undefined) claim.reasoning = c.reasoning
    return claim
  })

  const result: LLMExtractorCallResult = { claims }
  if (usage && usage.promptTokens !== undefined) {
    result.tokens = {
      prompt: usage.promptTokens,
      completion: usage.completionTokens ?? 0,
    }
  }
  return result
}

// ─── Extractor factory ──────────────────────────────────────────────────────

export interface CreateLLMExtractorOptions {
  /**
   * Override the LLM call. Tests pass a stub here; production uses the
   * default which wires through the ai-sdk.
   */
  llmCall?: LLMExtractorCall
  /** Override the extractor's reported name (defaults to 'llm-extractor'). */
  name?: string
}

export function createLLMExtractor(
  options: CreateLLMExtractorOptions = {},
): ClaimExtractor {
  const call = options.llmCall ?? defaultLLMCall
  const name = options.name ?? 'llm-extractor'

  return {
    name,
    description:
      "LLM-driven claim extraction using brandKit.models.grader. Proposes Evidence refs from the union of registered Verifiers' discover() outputs.",

    async extract(
      variant: Variant,
      ctx: ClaimExtractorContext,
    ): Promise<ExtractionResult> {
      const startedAt = Date.now()

      const menu = await buildDiscoveryMenu(ctx.verifiers, {
        workspaceRoot: ctx.workspaceRoot,
        brandKit: ctx.brandKit,
      })

      const menuText = renderMenu(menu.refs)
      const prompt = buildExtractorPrompt({ variant, ctx, menuText })

      const modelId = ctx.brandKit.models.grader

      let claims: ExtractedClaim[] = []
      let tokens: { prompt: number; completion: number } | undefined
      const warnings: string[] = [...menu.warnings]

      try {
        const result = await call({ modelId, prompt })
        claims = result.claims
        tokens = result.tokens
      } catch (err) {
        warnings.push(
          `LLM extraction failed (model=${modelId}): ${(err as Error).message}. ` +
            `Variant returned unchanged; no claims tagged.`,
        )
        return {
          text: variant.text,
          extracted: [],
          warnings,
          latencyMs: Date.now() - startedAt,
        }
      }

      const wrapped = wrapClaims(variant.text, claims)
      warnings.push(...wrapped.warnings)

      const result: ExtractionResult = {
        text: wrapped.text,
        extracted: claims,
        warnings,
        latencyMs: Date.now() - startedAt,
      }
      if (tokens) result.tokens = tokens
      return result
    },
  }
}

export const llmClaimExtractor: ClaimExtractor = createLLMExtractor()
