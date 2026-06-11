/**
 * Brand-kit proposer.
 *
 * Closes the feedback loop. Reads accumulated Langfuse signal (picks +
 * grader scores + HITL annotations) from past N days, summarizes it, and
 * asks a reasoning LLM to PROPOSE changes to the brand-kit (rules.json +
 * CANONICAL.md + model candidates). Output is a markdown report written
 * to a Drive `suggestions/` folder for the content team to review.
 *
 * The content operator is the GOVERNOR of the loop: they approve/reject
 * evidence-backed proposals rather than authoring rules from a blank page.
 * v0 is "manual apply" — the operator copy-pastes diffs into the brand-kit (or edits via the
 * Drive-edited brand-kit workflow once that ships). v1+ can layer
 * structured apply.
 *
 * Design choices:
 *
 *  - One LLM call per proposer run. Cheap, scales to ~100s of traces of
 *    context per call. Reasoning models (Gemini 2.5 Pro / Claude Sonnet /
 *    Opus) handle the qualitative analysis better than statistical fitting.
 *  - Markdown output, not JSON, for v0. The operator reads it directly. Future
 *    auto-apply can parse structured sections.
 *  - Evidence cites trace IDs. Every proposal grounded in observable
 *    Langfuse data — no hallucinated suggestions.
 *
 * Sister module to `picker.ts` — both consume Langfuse signal but at
 * different cadences: picker is fast (30s), proposer is slow (daily).
 */

import { readFile } from 'node:fs/promises'

import type {
  GetLangfuseTracesQuery,
  GetLangfuseTracesResponse,
} from 'langfuse-core'

import type { DestinationAdapter, ShipResult } from './destination/index.js'
import { generateVariant } from './models/index.js'
import type { BrandKit, ModelId } from './types.js'

// ─── Evidence shapes ────────────────────────────────────────────────────────

/** One score landed against a variant. Captures the full Langfuse shape so
 *  the proposer can distinguish auto-emitted signal (picked, llm-judge,
 *  brand-review) from explicit human HITL annotations (voice, on-brand,
 *  categorical labels like "ship-as-is" / "needs-edit", plus operator
 *  free-text comments). The qualitative `comment` is the highest-signal
 *  field — that's where the operator explains what they liked or didn't. */
export interface EvidenceScore {
  /** Numeric value. For categorical scores this is the optional numeric
   *  mapping if the score config defines one; otherwise undefined. */
  value?: number
  /** String value for categorical scores ("ship-as-is", "needs-edit", …). */
  stringValue?: string
  /** Free-text comment the operator wrote in the Langfuse UI alongside the score. */
  comment?: string
  /** Langfuse score data type — NUMERIC | CATEGORICAL | BOOLEAN. Helps
   *  the proposer interpret the score correctly. */
  dataType?: string
}

export interface EvidenceVariant {
  variantId: string
  model: string
  /** Per-grader / per-annotation signals keyed by score name. Holds the
   *  full Langfuse shape, not just the numeric value, so qualitative
   *  comments from human annotators land in the proposer prompt. */
  scores: Record<string, EvidenceScore>
  /** Snippet of variant text — capped so the LLM context doesn't explode. */
  outputSnippet: string
  /** True iff this variant won (`picked=1`). */
  picked: boolean
}

export interface EvidenceTrace {
  runId: string
  /** Trace-level metadata from the Langfuse trace. */
  brandKitName: string
  brandKitVersion: string
  /** Source brief (the operator instruction or transform prompt). */
  briefSnippet: string
  /** Variant fan-out for this run, in order. */
  variants: EvidenceVariant[]
  /** True iff at least one variant has a recorded pick. */
  hasPick: boolean
  /** Free-text comments attached to the trace via Langfuse's
   *  /api/public/comments — these are independent of scores. Used for
   *  qualitative annotations that don't fit a score config (e.g. "the
   *  opening line is too long" or "this whole batch missed the brief"). */
  traceComments: string[]
}

export interface EvidenceSummary {
  windowDays: number
  fetchedAt: string
  totalTraces: number
  pickedTraces: number
  traces: EvidenceTrace[]
}

// ─── Langfuse fetching (client injected for testability) ────────────────────

/** Minimal subset of the Langfuse SDK surface the proposer needs.
 *  Real impl: `new Langfuse({...})`. Test impl: a fake. */
export interface LangfuseEvidenceClient {
  fetchTraces(query: GetLangfuseTracesQuery): Promise<GetLangfuseTracesResponse>
  fetchTrace(traceId: string): Promise<{
    data: {
      id: string
      name?: string | null
      input?: unknown
      metadata?: Record<string, unknown> | null
      observations?: Array<{
        id: string
        name?: string | null
        type?: string
        model?: string | null
        output?: unknown
      }> | null
      scores?: Array<{
        name: string
        value?: number | null
        stringValue?: string | null
        comment?: string | null
        dataType?: string | null
        observationId?: string | null
      }> | null
    }
  }>
  /** Optional: pull trace-level comments via /api/public/comments. Some
   *  Langfuse SDK versions don't expose this; implementations that can't
   *  fetch comments should return [] rather than throwing — the proposer
   *  degrades gracefully. */
  fetchTraceComments?(traceId: string): Promise<string[]>
}

export interface FetchEvidenceOptions {
  client: LangfuseEvidenceClient
  brandKitName: string
  windowDays: number
  /** Hard cap on traces to fetch. Default 100. */
  maxTraces?: number
  /** Cap on per-variant output snippet length, in chars. Default 800. */
  snippetChars?: number
}

const DEFAULT_MAX_TRACES = 100
const DEFAULT_SNIPPET_CHARS = 800

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + ` … [truncated, ${s.length - n} chars]`
}

export async function fetchEvidence(
  opts: FetchEvidenceOptions,
): Promise<EvidenceSummary> {
  const fetchedAt = new Date().toISOString()
  const fromTimestamp = new Date(
    Date.now() - opts.windowDays * 24 * 60 * 60 * 1000,
  )
  const snippetChars = opts.snippetChars ?? DEFAULT_SNIPPET_CHARS
  const maxTraces = opts.maxTraces ?? DEFAULT_MAX_TRACES

  // Pull the list of recent traces tagged with this brand-kit.
  const list = await opts.client.fetchTraces({
    limit: maxTraces,
    fromTimestamp,
    tags: [opts.brandKitName],
  } as GetLangfuseTracesQuery)

  const traces: EvidenceTrace[] = []
  let pickedTraces = 0

  for (const t of list.data ?? []) {
    const detail = await opts.client.fetchTrace(t.id)
    const traceData = detail.data

    const meta = (traceData.metadata ?? {}) as Record<string, unknown>
    const brandKitName = String(meta['brand_kit'] ?? '<unknown>')
    const brandKitVersion = String(meta['brand_kit_version'] ?? '<unknown>')

    // Brief lives at trace.input.brief (or trace.input.brief.text).
    let briefSnippet = ''
    const input = traceData.input as { brief?: unknown } | string | undefined
    if (typeof input === 'string') briefSnippet = input
    else if (input && typeof input === 'object' && 'brief' in input) {
      const b = input.brief
      briefSnippet = typeof b === 'string' ? b : JSON.stringify(b)
    }
    briefSnippet = truncate(briefSnippet, snippetChars)

    // Variants = observations of type "GENERATION" with name starting with
    // "candidate" (graders use type "SPAN").
    const observations = traceData.observations ?? []
    const variantObs = observations.filter(
      (o) => o.type === 'GENERATION' && (o.name ?? '').startsWith('candidate'),
    )

    const variants: EvidenceVariant[] = []
    let traceHasPick = false

    for (const obs of variantObs) {
      const variantId = obs.id
      const model = obs.model ?? '<unknown>'
      const output =
        typeof obs.output === 'string'
          ? obs.output
          : JSON.stringify(obs.output ?? '')

      const variantScores: Record<string, EvidenceScore> = {}
      for (const s of traceData.scores ?? []) {
        // A score with observationId === variantId is attached to this
        // specific variant. A score with observationId === null is a
        // trace-level score (e.g. picked) that we attribute to every
        // variant so the LLM sees it consistently.
        if (s.observationId === variantId || s.observationId == null) {
          const sig: EvidenceScore = {}
          if (s.value !== undefined && s.value !== null) sig.value = s.value
          if (s.stringValue) sig.stringValue = s.stringValue
          if (s.comment) sig.comment = s.comment
          if (s.dataType) sig.dataType = s.dataType
          variantScores[s.name] = sig
        }
      }
      const picked = variantScores['picked']?.value === 1
      if (picked) traceHasPick = true

      variants.push({
        variantId,
        model,
        scores: variantScores,
        outputSnippet: truncate(output, snippetChars),
        picked,
      })
    }

    if (traceHasPick) pickedTraces++

    // Trace-level comments are independent of scores; pull separately
    // when the client supports it, fall back to [] otherwise.
    let traceComments: string[] = []
    if (opts.client.fetchTraceComments) {
      try {
        traceComments = await opts.client.fetchTraceComments(traceData.id)
      } catch {
        // best effort — don't fail the whole run because comments fetch failed
      }
    }

    traces.push({
      runId: traceData.id,
      brandKitName,
      brandKitVersion,
      briefSnippet,
      variants,
      hasPick: traceHasPick,
      traceComments,
    })
  }

  return {
    windowDays: opts.windowDays,
    fetchedAt,
    totalTraces: traces.length,
    pickedTraces,
    traces,
  }
}

// ─── Default Langfuse client builder ────────────────────────────────────────

/** Build a default client from LANGFUSE_* env. Returns null when keys unset
 *  — the CLI should bail out with a helpful error in that case rather than
 *  silently fetching nothing. */
export async function buildDefaultLangfuseClient(): Promise<LangfuseEvidenceClient | null> {
  const pk = process.env['LANGFUSE_PUBLIC_KEY']
  const sk = process.env['LANGFUSE_SECRET_KEY']
  const base = process.env['LANGFUSE_BASE_URL']
  if (!pk || !sk) return null
  const { Langfuse } = await import('langfuse')
  const lf = new Langfuse({
    publicKey: pk,
    secretKey: sk,
    ...(base ? { baseUrl: base } : {}),
  })
  const baseUrl = base ?? 'https://cloud.langfuse.com'
  const authHeader = `Basic ${Buffer.from(`${pk}:${sk}`).toString('base64')}`

  async function fetchTraceComments(traceId: string): Promise<string[]> {
    // The SDK doesn't expose comments directly across all release lines;
    // hit the public REST endpoint instead. Tolerant of failure — returns
    // [] on any HTTP / parse / network problem so a missing/older Langfuse
    // doesn't break the proposer.
    try {
      const res = await fetch(
        `${baseUrl}/api/public/comments?objectType=TRACE&objectId=${encodeURIComponent(traceId)}`,
        { headers: { Authorization: authHeader } },
      )
      if (!res.ok) return []
      const body = (await res.json()) as {
        data?: Array<{ content?: string | null }>
      }
      return (body.data ?? [])
        .map((c) => (typeof c.content === 'string' ? c.content : ''))
        .filter((s) => s.length > 0)
    } catch {
      return []
    }
  }

  return {
    fetchTraces: (q) => lf.fetchTraces(q),
    fetchTrace: (id) =>
      lf.fetchTrace(id) as ReturnType<LangfuseEvidenceClient['fetchTrace']>,
    fetchTraceComments,
  }
}

// ─── Prompt assembly ────────────────────────────────────────────────────────

export interface ProposerPromptInputs {
  brandKit: BrandKit
  rulesJson: string
  canonicalMd: string
  evidence: EvidenceSummary
}

export function buildProposerSystemPrompt(): string {
  return [
    'You are a brand-kit improver. Your job is to analyse evidence from recent generation+pick cycles and PROPOSE changes to the brand-kit that would make the next cycle produce better output.',
    '',
    'You have access to:',
    '  • The current brand-kit (rules.json + CANONICAL.md + model candidates).',
    '  • A list of recent generation traces from Langfuse. Each trace has the source brief, the variants produced, and ALL signal attached to each variant.',
    '',
    'SIGNAL TYPES — weight them in this order:',
    '',
    '  1. HUMAN ANNOTATIONS (highest signal). Content reviewers annotate traces in the Langfuse UI. Each annotation may carry:',
    '       • a numeric score (e.g. voice=4, on-brand=2)',
    '       • a categorical label (e.g. "ship-as-is" / "needs-edit" / "discard")',
    '       • a free-text comment explaining WHY ("the opening line is too long", "this whole batch missed the brief", "love the structure but rewrite the CTA")',
    '       • trace-level comments not tied to a specific score',
    '     These are gold. They tell you what an expert reviewer actually thought. Mine the comments for patterns — recurring complaints become candidate rules; recurring praise becomes canonical voice.',
    '',
    '  2. IMPLICIT PICKS (medium signal). The picker emits picked=1 on whichever variant the operator edited in Drive after publish. This is a binary signal — useful for "which model wins more often" routing, but does not explain WHY.',
    '',
    '  3. AUTO GRADER SCORES (context, not action). brand-review and llm-judge run automatically; their scores tell you what the system thinks, not what the human thinks. Use these to detect MIS-CALIBRATION — e.g. a rule that fires but humans pick the violating variant anyway means the rule is wrong.',
    '',
    'Propose changes ONLY when supported by observable evidence in the traces. Every proposal MUST cite the trace IDs it is grounded in. For proposals based on annotation comments, QUOTE the comment text verbatim as part of the evidence. Do not invent suggestions.',
    '',
    'Output FORMAT: a markdown document with this structure:',
    '',
    '```',
    '# Brand-kit improvement proposals — <date>',
    '',
    '## TL;DR',
    '- N traces analysed, P proposals.',
    '- Highest-confidence proposal: <title>.',
    '',
    '## Proposal 1: <short title>',
    '**Type:** add rule | remove rule | modify rule | reorder candidates | edit canonical',
    '**Confidence:** high | medium | low',
    '**Evidence:**',
    '- Trace <id1>: <one-sentence observation>',
    '- Trace <id2>: <one-sentence observation>',
    '',
    '**Suggested change:** (literal JSON snippet for rules.json, or markdown patch for CANONICAL.md, or new candidates array for brand-kit.json)',
    '```',
    '',
    'If the evidence is too thin (< 5 traces, no picks, no recurring patterns), say so explicitly in the TL;DR and emit zero proposals.',
    '',
    'Calibration:',
    '  • HIGH confidence: pattern observed in 5+ traces, consistent direction.',
    '  • MEDIUM: pattern in 3-4 traces, or some counter-examples.',
    '  • LOW: 2 traces, or weakly correlated signal — only worth surfacing because the cost of a wrong proposal is low.',
    '',
    'Do not propose anything you cannot back with cited traces.',
  ].join('\n')
}

export function buildProposerUserPrompt(inputs: ProposerPromptInputs): string {
  const lines: string[] = []
  lines.push(`# Brand-kit: ${inputs.brandKit.name} v${inputs.brandKit.version}`)
  lines.push('')
  lines.push('## Model candidates')
  lines.push('```')
  for (const c of inputs.brandKit.models.candidates) lines.push(`- ${c}`)
  lines.push('```')
  lines.push('')

  lines.push('## Current rules.json')
  lines.push('```json')
  lines.push(inputs.rulesJson.trim())
  lines.push('```')
  lines.push('')

  lines.push('## Current CANONICAL.md')
  lines.push('```markdown')
  lines.push(inputs.canonicalMd.trim())
  lines.push('```')
  lines.push('')

  lines.push(
    `## Evidence: ${inputs.evidence.totalTraces} traces (last ${inputs.evidence.windowDays} days, fetched ${inputs.evidence.fetchedAt}); ${inputs.evidence.pickedTraces} have a recorded pick`,
  )
  lines.push('')

  for (const t of inputs.evidence.traces) {
    lines.push(`### Trace ${t.runId}`)
    lines.push(`**Brief:** ${t.briefSnippet || '<empty>'}`)
    lines.push('')

    if (t.traceComments.length > 0) {
      lines.push('**Trace-level annotator comments:**')
      for (const c of t.traceComments) {
        lines.push(`  > ${c.replaceAll('\n', '\n  > ')}`)
      }
      lines.push('')
    }

    lines.push('**Variants:**')
    for (const v of t.variants) {
      // Inline summary line of all score names + their numeric / categorical
      // representation. Detailed comments come below.
      const scoreParts: string[] = []
      const scoreCommentLines: string[] = []
      for (const [k, sig] of Object.entries(v.scores)) {
        const valueStr =
          sig.stringValue !== undefined
            ? `"${sig.stringValue}"`
            : sig.value !== undefined
              ? String(sig.value)
              : '?'
        scoreParts.push(`${k}=${valueStr}`)
        if (sig.comment) {
          scoreCommentLines.push(
            `    • ${k}${sig.dataType ? ` (${sig.dataType})` : ''}: ${sig.comment.replaceAll('\n', ' ')}`,
          )
        }
      }
      lines.push(
        `- ${v.variantId} (${v.model})${v.picked ? ' **← PICKED**' : ''}${
          scoreParts.length ? ` [${scoreParts.join(', ')}]` : ''
        }`,
      )
      if (scoreCommentLines.length > 0) {
        lines.push('  Human annotator comments:')
        for (const c of scoreCommentLines) lines.push(c)
      }
      lines.push(`  > ${v.outputSnippet.replaceAll('\n', '\n  > ')}`)
    }
    lines.push('')
  }

  if (inputs.evidence.totalTraces === 0) {
    lines.push(
      '_(No traces in window. Emit zero proposals and say so in the TL;DR.)_',
    )
  }

  return lines.join('\n')
}

// ─── Proposer orchestrator ──────────────────────────────────────────────────

export interface ProposerLogger {
  (
    level: 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ): void
}

const defaultLogger: ProposerLogger = (level, msg, meta) => {
  const stamp = new Date().toISOString()
  const tail = meta ? ` ${JSON.stringify(meta)}` : ''
  console[level === 'error' ? 'error' : 'log'](
    `[${stamp}] [proposer:${level}] ${msg}${tail}`,
  )
}

export interface RunProposerOptions {
  brandKit: BrandKit
  /** Path to the rules.json. Read once + embedded in the prompt. */
  rulesPath: string
  /** Path to the CANONICAL.md. Read once + embedded in the prompt. */
  canonicalPath: string
  /** Look-back window in days. */
  windowDays: number
  /** Optional cap on traces to pull (default 100). */
  maxTraces?: number
  /** Optional cap on per-variant output snippet chars (default 800). */
  snippetChars?: number
  /** Model id for the proposer analysis call. Defaults to a beefy
   *  reasoning model — Gemini 2.5 Pro on Vertex. */
  analyzerModel?: ModelId
  /** Override the Langfuse client (tests inject a fake). */
  langfuseClient?: LangfuseEvidenceClient | null
  log?: ProposerLogger
}

export interface ProposerResult {
  evidence: EvidenceSummary
  markdown: string
  /** The model id that produced the analysis. */
  analyzerModel: ModelId
}

const DEFAULT_ANALYZER_MODEL: ModelId = 'google-vertex/gemini-2.5-pro'

export async function runProposer(
  opts: RunProposerOptions,
): Promise<ProposerResult> {
  const log = opts.log ?? defaultLogger
  const analyzerModel = opts.analyzerModel ?? DEFAULT_ANALYZER_MODEL

  // Resolve Langfuse client.
  let client = opts.langfuseClient
  if (client === undefined) {
    client = await buildDefaultLangfuseClient()
  }
  if (!client) {
    throw new Error(
      'Langfuse client unavailable — set LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY (+ optional LANGFUSE_BASE_URL) before running the proposer.',
    )
  }

  log('info', `pulling evidence from Langfuse`, {
    brandKit: opts.brandKit.name,
    windowDays: opts.windowDays,
    maxTraces: opts.maxTraces ?? DEFAULT_MAX_TRACES,
  })

  const evidence = await fetchEvidence({
    client,
    brandKitName: opts.brandKit.name,
    windowDays: opts.windowDays,
    ...(opts.maxTraces !== undefined ? { maxTraces: opts.maxTraces } : {}),
    ...(opts.snippetChars !== undefined
      ? { snippetChars: opts.snippetChars }
      : {}),
  })

  log('info', `evidence pulled`, {
    totalTraces: evidence.totalTraces,
    pickedTraces: evidence.pickedTraces,
  })

  // Load rules + canonical for the prompt.
  const [rulesJson, canonicalMd] = await Promise.all([
    readFile(opts.rulesPath, 'utf8').catch(
      () => '{ "schema_version": "0.0.0", "rule_groups": {} }',
    ),
    readFile(opts.canonicalPath, 'utf8').catch(() => '# (canonical missing)'),
  ])

  const systemPrompt = buildProposerSystemPrompt()
  const userPrompt = buildProposerUserPrompt({
    brandKit: opts.brandKit,
    rulesJson,
    canonicalMd,
    evidence,
  })

  log('info', `calling analyzer model`, { analyzerModel })

  // Reuse the existing variant generator. It already handles fallback
  // error reporting, latency capture, etc.
  const variant = await generateVariant({
    modelId: analyzerModel,
    prompt: userPrompt,
    systemPrompt,
    variantId: `proposer_${Date.now()}`,
  })

  if (variant.text.startsWith('[model call failed:')) {
    throw new Error(
      `proposer analyzer call failed: ${variant.text.slice(0, 200)}…`,
    )
  }

  log('info', `analyzer returned`, {
    chars: variant.text.length,
    latencyMs: variant.latencyMs,
  })

  return {
    evidence,
    markdown: variant.text,
    analyzerModel,
  }
}

// ─── Publishing the proposal markdown to Drive ──────────────────────────────

export interface PublishProposalsOptions {
  destinationAdapter: DestinationAdapter
  destinationName: string
  destinationConfig: Record<string, unknown>
  result: ProposerResult
}

export async function publishProposals(
  opts: PublishProposalsOptions,
): Promise<ShipResult> {
  return opts.destinationAdapter.publish({
    copy: opts.result.markdown,
    targetName: opts.destinationName,
    config: opts.destinationConfig,
  })
}
