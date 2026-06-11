/**
 * Operator-pick recording.
 *
 * After `generate()` produces a ranked variant list, the operator picks one
 * (optionally with edits) and ships it. This module records the pick as a
 * Langfuse score on the original run's trace so the pick + edits are
 * persisted alongside the generation data — the gold label for downstream
 * judge calibration per the architecture ADR.
 *
 * Graceful no-config: when Langfuse env vars are unset, returns
 * `{ ok: false, reason: ... }` so the CLI surfaces the missing config
 * without throwing. The pipeline still runs end-to-end; the pick just
 * isn't observable until Langfuse is wired.
 *
 * The `recorder` argument is injectable so tests can stub the Langfuse
 * interaction without going through the SDK.
 */

import { Langfuse } from 'langfuse'

export interface PickArgs {
  runId: string
  variantId: string
  /** Optional final-shipped copy. First 1000 chars stored as the score comment. */
  edits?: string
}

export interface PickResult {
  ok: boolean
  /** Human-readable failure detail. Set when ok=false. */
  reason?: string
}

/** Injectable recorder. Default impl writes to Langfuse. */
export type PickRecorder = (args: PickArgs) => Promise<PickResult>

const COMMENT_MAX_CHARS = 1000

const defaultPickRecorder: PickRecorder = async (args) => {
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY']
  const secretKey = process.env['LANGFUSE_SECRET_KEY']
  const baseUrl = process.env['LANGFUSE_BASE_URL']

  if (!publicKey || !secretKey) {
    return {
      ok: false,
      reason:
        'Langfuse not configured (LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY required). Pick was not recorded.',
    }
  }

  try {
    const client = new Langfuse({
      publicKey,
      secretKey,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    })

    // Attach a "pick" score on the original trace. Binary signal; the
    // comment carries the edited copy (truncated) so the picked + edited
    // text travels with the trace.
    client.score({
      traceId: args.runId,
      observationId: args.variantId,
      name: 'operator_pick',
      value: 1,
      ...(args.edits
        ? { comment: args.edits.slice(0, COMMENT_MAX_CHARS) }
        : {}),
    })

    // Update the original trace's metadata so the picked variant is
    // visible in the trace overview (separate from the score column).
    client.trace({
      id: args.runId,
      metadata: {
        picked_variant: args.variantId,
        picked_at: new Date().toISOString(),
        edited: Boolean(args.edits),
      },
    })

    await client.flushAsync()
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      reason: `Langfuse error: ${(err as Error).message ?? String(err)}`,
    }
  }
}

/** Record an operator pick + optional edits against a prior generate() run. */
export async function recordPick(
  args: PickArgs,
  recorder: PickRecorder = defaultPickRecorder,
): Promise<PickResult> {
  if (!args.runId) {
    return { ok: false, reason: 'runId is required' }
  }
  if (!args.variantId) {
    return { ok: false, reason: 'variantId is required' }
  }
  return recorder(args)
}
