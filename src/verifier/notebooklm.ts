/**
 * `notebooklm:` Verifier — checks that a NotebookLM corpus has citations
 * relevant to a claim.
 *
 * Ref format: `notebooklm:<notebook-id>`
 * Example:    `<claim ref="notebooklm:<notebook-uuid>">claim text</claim>`
 *
 * Empty body falls back to the `NOTEBOOKLM_NOTEBOOK_ID` env var. Consumers
 * that want named notebooks (e.g. "training-science" → uuid) wire that
 * mapping in their own app and pass the resolved id to the ref. Keeps
 * copy-pipeline core free of consumer-specific notebook handles.
 *
 * V1 verdict is intentionally weak:
 *   - Citations returned → `verified` (the corpus has *something* relevant)
 *   - No citations      → `unverified` (corpus didn't surface a source)
 *   - Script exit 3     → `error` with rate-limit message
 *   - Other failures    → `error`
 *
 * "Citations present" is not the same as "the citations support the claim" —
 * a richer LLM-as-judge step that interprets the response against the claim
 * is a deliberate follow-up. The weak verdict is still useful at the gate:
 * zero citations is a strong "this assertion isn't in our corpus" signal.
 *
 * No `discover()` — NotebookLM corpora are unbounded query spaces; the
 * extractor proposes refs without enumeration.
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { openai } from '@ai-sdk/openai'
import { vertex } from '@ai-sdk/google-vertex'
import { vertexAnthropic } from '@ai-sdk/google-vertex/anthropic'
import { z } from 'zod'

import type { ModelId } from '../types.js'
import type { Verifier, VerifyArgs, VerifyResult } from './index.js'

const DEFAULT_SCRIPT_PATH = join(
  homedir(),
  '.claude/skills/notebooklm-query/query.sh',
)

/** One citation parsed out of the script output. */
export interface NotebookLMCitation {
  /** Citation number as rendered in the response text (1-indexed). */
  n: number
  /** Source filename, e.g. `schoenfeld-science-development-...pdf`. */
  file: string
}

/** Result of one NotebookLM call, before verdict logic. */
export interface NotebookLMRunResult {
  responseText: string
  citations: NotebookLMCitation[]
  /** Notebook id parsed from the citations header (if present). */
  notebookId?: string
}

/** Injectable NotebookLM call. Default impl shells out to query.sh. */
export type NotebookLMCall = (args: {
  query: string
  notebookId: string
  timeoutSec?: number
}) => Promise<NotebookLMRunResult>

interface ScriptError extends Error {
  exitCode: number
  stderr: string
}

/**
 * Parse the stdout of `query.sh` into structured result. Exported for
 * direct unit testing — see tests/notebooklm.test.ts.
 *
 * Output format from format.py:
 *   <response text, possibly multiline>
 *
 *   --- citations (notebook <id>) ---
 *     [1] file1.pdf
 *     [2] file2.pdf
 */
export function _parseScriptOutput(
  stdout: string,
  notebookIdHint?: string,
): NotebookLMRunResult {
  const lines = stdout.split('\n')
  const headerIdx = lines.findIndex((l) => l.startsWith('--- citations'))

  let responseText: string
  let citationLines: string[]
  let notebookId: string | undefined = notebookIdHint

  if (headerIdx === -1) {
    responseText = stdout.trim()
    citationLines = []
  } else {
    responseText = lines.slice(0, headerIdx).join('\n').trim()
    citationLines = lines
      .slice(headerIdx + 1)
      .filter((l) => l.trim().length > 0)

    const headerLine = lines[headerIdx]
    if (headerLine) {
      const match = /^--- citations \(notebook (.+?)\) ---$/.exec(headerLine)
      if (match?.[1] && match[1] !== '<unknown>') {
        notebookId = match[1]
      }
    }
  }

  const citations: NotebookLMCitation[] = []
  for (const line of citationLines) {
    const m = /^\s*\[(\d+)\]\s+(.+)$/.exec(line)
    if (m?.[1] && m[2]) {
      citations.push({ n: parseInt(m[1], 10), file: m[2].trim() })
    }
  }

  const result: NotebookLMRunResult = { responseText, citations }
  if (notebookId !== undefined) result.notebookId = notebookId
  return result
}

function spawnScriptCall(scriptPath: string): NotebookLMCall {
  return async ({ query, notebookId, timeoutSec }) => {
    const args: string[] = ['--notebook', notebookId]
    if (timeoutSec !== undefined) {
      args.push('--timeout', String(timeoutSec))
    }
    args.push(query)

    return new Promise<NotebookLMRunResult>((resolve, reject) => {
      const child = spawn(scriptPath, args)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      child.on('error', reject)
      child.on('close', (code) => {
        const exitCode = code ?? -1
        if (exitCode !== 0) {
          const err: ScriptError = Object.assign(
            new Error(
              `notebooklm-query exited ${exitCode}: ${stderr.trim() || '<no stderr>'}`,
            ),
            { exitCode, stderr },
          )
          reject(err)
          return
        }
        resolve(_parseScriptOutput(stdout, notebookId))
      })
    })
  }
}

/**
 * A judge's interpretation of whether a NotebookLM response supports a claim.
 *
 * `supports`     — the corpus actually backs the claim
 * `contradicts`  — the corpus disagrees with or refutes the claim
 * `inconclusive` — citations exist but don't directly support or refute
 */
export type JudgeVerdict = 'supports' | 'contradicts' | 'inconclusive'

export interface JudgeResult {
  verdict: JudgeVerdict
  rationale: string
}

/** Optional LLM-as-judge step. When configured, the verifier calls this
 * after retrieving citations to determine whether they actually support
 * the claim. Without a judge, citations-presence alone determines verdict. */
export type JudgeFn = (args: {
  claim: string
  citations: NotebookLMCitation[]
  responseText: string
}) => Promise<JudgeResult>

export interface NotebookLMVerifierConfig {
  /** Override the call function. Tests pass a stub. Default shells out. */
  call?: NotebookLMCall
  /** Notebook id used when the ref body is empty. Defaults to env var. */
  defaultNotebookId?: string
  /** Path to query.sh. Defaults to ~/.claude/skills/notebooklm-query/query.sh. */
  scriptPath?: string
  /** Per-query timeout passed through to the script. */
  timeoutSec?: number
  /**
   * Optional LLM-as-judge step. When set, the verifier interprets the
   * NotebookLM response + citations against the claim instead of using
   * citations-presence alone. Use `createDefaultJudge(modelId)` for the
   * AI SDK-backed default, or implement your own JudgeFn.
   */
  judge?: JudgeFn
}

function notebookLMURL(notebookId: string): string {
  return `https://notebooklm.google.com/notebook/${notebookId}`
}

// ─── Default LLM-as-judge ───────────────────────────────────────────────────

const judgeSchema = z.object({
  verdict: z
    .enum(['supports', 'contradicts', 'inconclusive'])
    .describe(
      'Whether the corpus response actually backs the claim. ' +
        '"supports" requires direct evidence; "contradicts" means the corpus disagrees; ' +
        '"inconclusive" means citations exist but do not address the specific claim.',
    ),
  rationale: z
    .string()
    .describe(
      'One to two sentences explaining the verdict; cite specific phrasing from the response when possible.',
    ),
})

function resolveJudgeModel(modelId: ModelId) {
  const slash = modelId.indexOf('/')
  if (slash <= 0) {
    throw new Error(
      `invalid judge model id "${modelId}" — expected "provider/name"`,
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
    case 'google-vertex':
      return vertex(name)
    case 'anthropic-vertex':
      return vertexAnthropic(name)
    default:
      throw new Error(
        `unknown judge provider "${provider}" in model id "${modelId}" — supported: anthropic, google, openai, google-vertex, anthropic-vertex`,
      )
  }
}

export function buildJudgePrompt(args: {
  claim: string
  citations: NotebookLMCitation[]
  responseText: string
}): string {
  const { claim, citations, responseText } = args
  const citationsList = citations.length
    ? citations.map((c) => `  [${c.n}] ${c.file}`).join('\n')
    : '  (none)'
  return `You are judging whether a research corpus supports a specific factual claim.

CLAIM:
"""
${claim}
"""

The corpus query returned this response (cited PDFs are listed by [number]):
"""
${responseText}
"""

Citation index:
${citationsList}

Decide:
- "supports" if the response describes evidence directly backing the claim
- "contradicts" if the response describes evidence directly refuting the claim
- "inconclusive" if citations exist but the response does not specifically address the claim

Be strict. "Supports" is only for direct, on-point evidence. Tangentially-related research or vague hedging is "inconclusive", not "supports".`
}

/**
 * AI-SDK-backed default judge. Pass the resulting JudgeFn into
 * NotebookLMVerifierConfig.judge.
 */
export function createDefaultJudge(modelId: ModelId): JudgeFn {
  return async ({ claim, citations, responseText }) => {
    const model = resolveJudgeModel(modelId)
    const prompt = buildJudgePrompt({ claim, citations, responseText })
    const { object } = await generateObject({
      model,
      schema: judgeSchema,
      prompt,
      temperature: 0.1,
    })
    return { verdict: object.verdict, rationale: object.rationale }
  }
}

export function createNotebookLMVerifier(
  config: NotebookLMVerifierConfig = {},
): Verifier {
  const scriptPath = config.scriptPath ?? DEFAULT_SCRIPT_PATH
  const call = config.call ?? spawnScriptCall(scriptPath)
  const timeoutSec = config.timeoutSec

  // Serialize verify() calls. The default spawn-the-script implementation
  // shares a single agent-browser daemon + browser profile; parallel
  // queries collide ("daemon already running" / wrong Submit-button
  // state). Even when a consumer supplies a custom call we keep the
  // serialization — most NotebookLM-shaped backends share a session.
  let chain: Promise<void> = Promise.resolve()
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  // process.env is read lazily so consumers can set NOTEBOOKLM_NOTEBOOK_ID
  // after module import (e.g. inside main()) without losing the fallback.
  const resolveDefaultNotebookId = (): string | undefined =>
    config.defaultNotebookId ?? process.env['NOTEBOOKLM_NOTEBOOK_ID']

  return {
    prefix: 'notebooklm',
    name: 'notebooklm-claim',
    description:
      'Checks a claim against a NotebookLM corpus by running it as a query; verified if the corpus returns at least one citation. Citations-present is a weaker signal than LLM-judged support — an optional follow-up.',

    async verify(args: VerifyArgs): Promise<VerifyResult> {
      const verifiedAt = new Date().toISOString()
      const notebookId = args.ref || resolveDefaultNotebookId()

      if (!notebookId) {
        return {
          verdict: 'unverified',
          reason: 'no NotebookLM notebook id provided',
          hint: "set the ref body (e.g. 'notebooklm:<uuid>') or NOTEBOOKLM_NOTEBOOK_ID env var",
        }
      }

      let run: NotebookLMRunResult
      try {
        const callArgs: Parameters<NotebookLMCall>[0] = {
          query: args.claim,
          notebookId,
        }
        if (timeoutSec !== undefined) callArgs.timeoutSec = timeoutSec
        run = await enqueue(() => call(callArgs))
      } catch (err) {
        const e = err as ScriptError
        if (e.exitCode === 3) {
          return {
            verdict: 'error',
            message:
              'NotebookLM daily chat limit reached; retry tomorrow or upgrade to Plus tier',
          }
        }
        return {
          verdict: 'error',
          message: `notebooklm-query failed: ${e.message ?? String(err)}`,
        }
      }

      // Trace shape — the auditable provenance for this verification. Every
      // verdict (verified / unverified / error after a successful call)
      // includes the same fields so downstream consumers don't have to
      // branch. Consumers publishing a public source page should treat this
      // as the authoritative artifact for the run.
      const baseTrace = {
        verifier: 'notebooklm-claim' as const,
        verifiedAt,
        notebookId,
        notebookUrl: notebookLMURL(notebookId),
        query: args.claim,
        responseText: run.responseText,
        citations: run.citations,
      }

      if (run.citations.length === 0) {
        return {
          verdict: 'unverified',
          reason: 'NotebookLM returned no citations for this claim',
          hint: "the corpus likely doesn't cover this assertion; revise the claim or add sources",
          trace: baseTrace,
        }
      }

      const citationsLabel = run.citations
        .map((c) => `[${c.n}] ${c.file}`)
        .join('; ')

      // Without a judge: citations-presence is the verdict (weak but useful).
      if (!config.judge) {
        return {
          verdict: 'verified',
          source: { uri: notebookLMURL(notebookId) },
          supporting: citationsLabel,
          trace: { ...baseTrace, method: 'citations-present' as const },
        }
      }

      // With a judge: ask whether the citations actually back the claim.
      const judgePromptUsed = buildJudgePrompt({
        claim: args.claim,
        citations: run.citations,
        responseText: run.responseText,
      })
      let judged: JudgeResult
      try {
        judged = await config.judge({
          claim: args.claim,
          citations: run.citations,
          responseText: run.responseText,
        })
      } catch (err) {
        return {
          verdict: 'error',
          message: `LLM judge failed: ${(err as Error).message ?? String(err)}`,
          trace: {
            ...baseTrace,
            method: 'llm-judge' as const,
            judgePrompt: judgePromptUsed,
            judgeError: (err as Error).message ?? String(err),
          },
        }
      }

      const supporting = `${judged.rationale} (citations: ${citationsLabel})`
      const judgeTrace = {
        ...baseTrace,
        method: 'llm-judge' as const,
        judgePrompt: judgePromptUsed,
        judgeVerdict: judged.verdict,
        judgeRationale: judged.rationale,
      }

      if (judged.verdict === 'supports') {
        return {
          verdict: 'verified',
          source: { uri: notebookLMURL(notebookId) },
          supporting,
          trace: judgeTrace,
        }
      }

      // contradicts / inconclusive — gated as unverified so the claim
      // gets attention rather than silently shipping. Reason carries the
      // judge's specific verdict.
      const reasonPrefix =
        judged.verdict === 'contradicts'
          ? 'judge: corpus contradicts the claim'
          : 'judge: citations exist but do not directly support the claim'
      return {
        verdict: 'unverified',
        reason: `${reasonPrefix}. ${judged.rationale}`,
        hint: `cited sources: ${citationsLabel}`,
        trace: judgeTrace,
      }
    },
  }
}

/**
 * Default-configured NotebookLM verifier. Not registered in
 * `defaultVerifiers()` — consumers opt in via `registerVerifier()` because
 * the script + auth dependency isn't universal.
 */
export const notebookLMVerifier: Verifier = createNotebookLMVerifier()
