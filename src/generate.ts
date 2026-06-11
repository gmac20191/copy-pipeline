/**
 * The pipeline's `generate()` entry point.
 *
 * Brief → retrieve from named corpora → fan out to candidate models → grade
 * each variant → return ranked results. The operator pick (and any post-pick
 * edits) is captured by the CLI / future web UI; this function returns the
 * pre-pick state.
 *
 * Wired:
 *   - Model fan-out — Vercel AI SDK + provider adapters (anthropic / google /
 *     openai) when env keys are present; explanatory stubs otherwise.
 *   - Grading — brand-review shell-out + LLM voice judge run over each variant.
 *   - Grounding — pgvector retrieval per ADR 0001 when DATABASE_URL is set;
 *     graceful no-op otherwise.
 *   - Langfuse tracing — 1 trace/run + per-model generation + per-grader scores
 *     when LANGFUSE_* env vars set.
 */

import { defaultGraders } from './grader/index.js'
import { resolveEmbedder } from './grounding/embed.js'
import {
  defaultGroundingSources,
  type GroundingSource,
} from './grounding/index.js'
import { generateVariant } from './models/index.js'
import { createTracer } from './tracing/langfuse.js'
import type {
  BrandKit,
  Brief,
  Finding,
  GenerateOptions,
  GenerationRun,
  GradedVariant,
  GroundingChunk,
  Variant,
} from './types.js'

export async function generate(opts: GenerateOptions): Promise<GenerationRun> {
  const {
    brief,
    brandKit,
    traceId,
    graders: gradersOverride,
    sourceDocument,
  } = opts

  const runId =
    traceId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  // ── Grounding retrieval (REAL via pgvector) ────────────────────────────
  // For each handle in brief.ground that maps to an active corpus in
  // brand-kit, dispatch to the right backend and collect chunks. Deferred
  // corpora are skipped silently. Failures within a backend become single
  // explanatory chunks (graceful — pipeline keeps running).
  // ────────────────────────────────────────────────────────────────────────
  const groundingChunks = await retrieveGrounding(brandKit, brief)

  // ── System prompt composition ──────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    brandKit,
    brief,
    groundingChunks,
    sourceDocument,
  )

  // In transform mode the per-call prompt is the source document (with the
  // brief.text instruction embedded). In generate mode the per-call prompt
  // is just brief.text.
  const variantPrompt = sourceDocument
    ? buildTransformPrompt(brief, sourceDocument)
    : brief.text

  // ── Tracing init (graceful no-op when LANGFUSE_* env vars unset) ───────
  const tracer = createTracer({ runId, brief, brandKit })

  const variants: Variant[] = await Promise.all(
    brandKit.models.candidates.map(async (modelId, i) => {
      const variant = await generateVariant({
        modelId,
        prompt: variantPrompt,
        variantId: `${runId}_v${i}`,
        systemPrompt,
      })
      const failed = variant.text.startsWith('[model call failed:')
      tracer.recordVariant({
        variantId: variant.id,
        model: variant.model,
        prompt: variantPrompt,
        systemPrompt,
        output: variant.text,
        ...(variant.tokens
          ? {
              promptTokens: variant.tokens.prompt,
              completionTokens: variant.tokens.completion,
            }
          : {}),
        ...(variant.latencyMs !== undefined
          ? { latencyMs: variant.latencyMs }
          : {}),
        failed,
      })
      return variant
    }),
  )

  // ── Grading (REAL) ─────────────────────────────────────────────────────
  const graders = gradersOverride ?? (await defaultGraders())

  const graded: GradedVariant[] = await Promise.all(
    variants.map(async (variant): Promise<GradedVariant> => {
      const findings: Finding[] = []
      const scores: number[] = []

      for (const grader of graders) {
        const result = await grader.grade(variant, {
          brandKit,
          siblings: variants.filter((v) => v.id !== variant.id),
          briefText: brief.text,
        })
        findings.push(...result.findings)
        scores.push(result.score)
        tracer.recordGrade({
          variantId: variant.id,
          graderName: grader.name,
          score: result.score,
          findings: result.findings,
        })
      }

      const compositeScore =
        scores.length > 0
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : 0

      return {
        variant,
        findings,
        score: compositeScore,
      }
    }),
  )

  // Sort highest-scoring first so the operator sees the best variant on top.
  graded.sort((a, b) => b.score - a.score)

  // ── Trace close ─────────────────────────────────────────────────────────
  await tracer.end({
    summary: {
      variantCount: graded.length,
      topScore: graded[0]?.score ?? 0,
      models: brandKit.models.candidates,
    },
  })

  return {
    runId,
    brief,
    brandKit,
    groundingChunks,
    graded,
  }
}

/**
 * Look up each requested corpus from the brand-kit, dispatch to the
 * matching backend, and collect chunks. Deferred corpora are skipped;
 * unknown backends or unknown handles produce explanatory empty results.
 */
async function retrieveGrounding(
  brandKit: BrandKit,
  brief: Brief,
): Promise<GroundingChunk[]> {
  if (!brief.ground || brief.ground.length === 0) {
    return []
  }

  const sources: GroundingSource[] = await defaultGroundingSources()
  const byBackend = new Map<string, GroundingSource>()
  for (const s of sources) byBackend.set(s.backend, s)

  const embedder = resolveEmbedder(brandKit.models.embedder)
  const chunks: GroundingChunk[] = []

  for (const handle of brief.ground) {
    const corpus = brandKit.corpora[handle]
    if (!corpus) {
      chunks.push({
        source: handle,
        backend: 'unknown',
        text: `[corpus "${handle}" not declared in brand-kit.corpora — check spelling]`,
        metadata: { unknown: true },
      })
      continue
    }
    if (corpus.status === 'deferred') {
      // No noise; deferred is intentional and known. Caller can see the
      // corpus is configured but indexing hasn't been wired yet.
      continue
    }
    const source = byBackend.get(corpus.backend)
    if (!source) {
      chunks.push({
        source: handle,
        backend: corpus.backend,
        text: `[no GroundingSource registered for backend "${corpus.backend}"]`,
        metadata: { unregistered: true },
      })
      continue
    }
    try {
      const retrieved = await source.retrieve({
        corpusHandle: handle,
        indexName: corpus.index_name,
        query: { text: brief.text, topK: 5 },
        embedder,
      })
      chunks.push(...retrieved)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      chunks.push({
        source: handle,
        backend: corpus.backend,
        text: `[retrieval failed for corpus "${handle}": ${msg}]`,
        metadata: { failed: true, error: msg },
      })
    }
  }

  return chunks
}

/**
 * Compose the system prompt from the brand-kit + retrieved grounding chunks.
 *
 * The model can't read CANONICAL.md from disk — anything load-bearing must
 * be in the prompt. V0.1.0-alpha.5 ships:
 *   - brand identity (name + description)
 *   - canonical-spec reference (path; chunks below provide content)
 *   - retrieved grounding chunks, source-tagged
 *   - audience-aware register instruction
 *   - no-preamble guidance
 *
 * Future versions may add:
 *   - excerpts from CANONICAL.md inlined (banned phrases section especially)
 *   - exemplar copy as few-shot
 *   - per-brief override / additional instructions
 */
/** Per-call user prompt for TRANSFORM mode. Wraps the brief instruction
 * around the source document. */
function buildTransformPrompt(brief: Brief, sourceDocument: string): string {
  return `INSTRUCTION:
${brief.text}

SOURCE DOCUMENT (apply the instruction to this content; preserve intent and structure unless explicitly told otherwise):

"""
${sourceDocument}
"""`
}

function buildSystemPrompt(
  brandKit: BrandKit,
  brief: Brief,
  chunks: GroundingChunk[],
  sourceDocument?: string,
): string {
  const parts: string[] = []
  const mode = sourceDocument ? 'transforming' : 'generating'
  parts.push(`You are ${mode} copy for the ${brandKit.name} brand.`)
  if (sourceDocument) {
    parts.push(
      'TRANSFORM MODE: a source document is provided in the user message. ' +
        'Improve it per the instruction while preserving meaning and ' +
        'structure. Do not invent new claims; do not summarise or shorten ' +
        "unless the instruction asks for it. Treat the brand-kit's voice " +
        'rules as the editorial gate.',
    )
  }

  if (brandKit.description) {
    parts.push(brandKit.description)
  }

  const marketing = brandKit.canonicals['marketing']
  if (marketing?.spec) {
    parts.push(
      `Brand voice and audience rules are defined canonically at \`${marketing.spec}\`. ` +
        `Treat the grounding chunks below as authoritative excerpts. ` +
        `Avoid generic SaaS / wellness-app voice; avoid hedge phrases; avoid companion-coach warmth.`,
    )
  }

  // Group chunks by source so the model sees them clustered. Skipped/empty
  // chunks (deferred corpora explanatory text, fallback messages) are still
  // surfaced so the operator can see what would have grounded the call.
  const grouped = new Map<string, GroundingChunk[]>()
  for (const chunk of chunks) {
    const list = grouped.get(chunk.source) ?? []
    list.push(chunk)
    grouped.set(chunk.source, list)
  }

  if (grouped.size > 0) {
    const lines: string[] = ['GROUNDING CHUNKS (treat as authoritative):']
    for (const [source, list] of grouped) {
      lines.push('')
      lines.push(`── source: ${source} (${list.length} chunk(s)) ──`)
      for (const chunk of list) {
        lines.push(chunk.text)
      }
    }
    parts.push(lines.join('\n'))
  }

  if (brief.ground && brief.ground.length > 0 && grouped.size === 0) {
    parts.push(
      `Grounding corpora were requested (${brief.ground.join(', ')}) but no chunks were returned. Proceed with brand-kit voice rules only.`,
    )
  }

  parts.push(
    'Produce one focused draft. Match the brief tightly. No preamble, no caveats, no meta-commentary about being an AI.',
  )

  return parts.join('\n\n')
}
