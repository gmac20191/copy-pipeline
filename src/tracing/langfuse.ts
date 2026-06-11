/**
 * Langfuse tracing wrapper.
 *
 * Emits one trace per `generate()` run with nested spans:
 *   - top-level trace: brief + brand-kit name + composite results
 *   - one `generation` per candidate model call (prompt, output, tokens, latency)
 *   - one `span` per grader invocation per variant (score, findings count)
 *
 * Graceful no-config: when `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` are
 * unset, `createTracer()` returns a no-op tracer so the pipeline still runs
 * end-to-end without observability. When env vars are set but the server is
 * unreachable, the SDK drops events async (Langfuse handles that internally).
 *
 * Env vars consumed:
 *   - LANGFUSE_PUBLIC_KEY   (required to enable)
 *   - LANGFUSE_SECRET_KEY   (required to enable)
 *   - LANGFUSE_BASE_URL     (optional; default is Langfuse cloud)
 *   - LANGFUSE_RUN_LABEL    (optional; tagged onto the trace name for filtering)
 *
 * Common local-dev pattern: run Langfuse via docker-compose and point
 * LANGFUSE_BASE_URL at it (e.g. http://localhost:3004). Pipe to Langfuse
 * cloud or any hosted instance otherwise.
 */

import { Langfuse, type LangfuseTraceClient } from 'langfuse'

import type { Brief, BrandKit, Finding } from '../types.js'

export interface PipelineTracer {
  /** True when Langfuse is configured + this run will emit traces. */
  readonly enabled: boolean
  /** Trace id (== generate() runId). */
  readonly runId: string
  /** Record one variant produced by a model adapter. */
  recordVariant(args: {
    variantId: string
    model: string
    prompt: string
    systemPrompt?: string | undefined
    output: string
    promptTokens?: number
    completionTokens?: number
    latencyMs?: number
    failed?: boolean
  }): void
  /** Record one grader's result for one variant. */
  recordGrade(args: {
    variantId: string
    graderName: string
    score: number
    findings: Finding[]
  }): void
  /** End the trace + flush. Always await before process exit. */
  end(args?: { summary?: Record<string, unknown> }): Promise<void>
}

class NoopTracer implements PipelineTracer {
  readonly enabled = false
  constructor(public readonly runId: string) {}
  recordVariant(): void {}
  recordGrade(): void {}
  async end(): Promise<void> {}
}

class LangfuseTracer implements PipelineTracer {
  readonly enabled = true
  private trace: LangfuseTraceClient

  constructor(
    private client: Langfuse,
    public readonly runId: string,
    args: { brief: Brief; brandKit: BrandKit },
  ) {
    const label = process.env['LANGFUSE_RUN_LABEL']
    this.trace = this.client.trace({
      id: runId,
      name: label
        ? `copy-pipeline.generate :: ${label}`
        : 'copy-pipeline.generate',
      input: { brief: args.brief.text, ground: args.brief.ground ?? [] },
      metadata: {
        brand_kit: args.brandKit.name,
        brand_kit_version: args.brandKit.version,
        candidates: args.brandKit.models.candidates,
        grader_model: args.brandKit.models.grader,
      },
      tags: ['copy-pipeline', args.brandKit.name],
    })
  }

  recordVariant(args: {
    variantId: string
    model: string
    prompt: string
    systemPrompt?: string | undefined
    output: string
    promptTokens?: number
    completionTokens?: number
    latencyMs?: number
    failed?: boolean
  }): void {
    this.trace.generation({
      id: args.variantId,
      name: args.failed ? 'candidate (failed)' : 'candidate',
      model: args.model,
      input: args.systemPrompt
        ? [
            { role: 'system', content: args.systemPrompt },
            { role: 'user', content: args.prompt },
          ]
        : args.prompt,
      output: args.output,
      ...(args.promptTokens !== undefined || args.completionTokens !== undefined
        ? {
            usage: {
              input: args.promptTokens ?? 0,
              output: args.completionTokens ?? 0,
            },
          }
        : {}),
      ...(args.latencyMs !== undefined
        ? {
            startTime: new Date(Date.now() - args.latencyMs),
            endTime: new Date(),
          }
        : {}),
      level: args.failed ? 'WARNING' : 'DEFAULT',
    })
  }

  recordGrade(args: {
    variantId: string
    graderName: string
    score: number
    findings: Finding[]
  }): void {
    const blockers = args.findings.filter(
      (f) => f.severity === 'blocker',
    ).length
    const warnings = args.findings.filter(
      (f) => f.severity === 'warning',
    ).length

    this.trace.span({
      name: `grade :: ${args.graderName}`,
      input: { variantId: args.variantId },
      output: {
        score: args.score,
        blockers,
        warnings,
        findings: args.findings.length,
      },
      level: blockers > 0 ? 'WARNING' : 'DEFAULT',
    })

    // Also write a Langfuse score so it shows up in the UI's metric columns.
    this.trace.score({
      name: args.graderName,
      value: args.score,
      observationId: args.variantId,
      ...(args.findings.length > 0
        ? {
            comment: args.findings
              .slice(0, 3)
              .map((f) => `[${f.severity}] ${f.message}`)
              .join('\n'),
          }
        : {}),
    })
  }

  async end(args?: { summary?: Record<string, unknown> }): Promise<void> {
    if (args?.summary) {
      this.trace.update({ output: args.summary })
    }
    await this.client.flushAsync()
  }
}

export function createTracer(args: {
  runId: string
  brief: Brief
  brandKit: BrandKit
}): PipelineTracer {
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY']
  const secretKey = process.env['LANGFUSE_SECRET_KEY']
  const baseUrl = process.env['LANGFUSE_BASE_URL']

  if (!publicKey || !secretKey) {
    return new NoopTracer(args.runId)
  }

  try {
    const client = new Langfuse({
      publicKey,
      secretKey,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    })
    return new LangfuseTracer(client, args.runId, args)
  } catch {
    return new NoopTracer(args.runId)
  }
}
