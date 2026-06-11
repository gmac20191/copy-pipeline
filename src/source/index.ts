/**
 * BriefSource interface.
 *
 * Symmetric with DestinationAdapter: where Destinations ship picked copy to
 * external systems, BriefSources pull briefs in from external systems. A
 * Source watches a feed (Google Drive folder, CloudCannon markdown directory,
 * Slack channel, webhook endpoint, etc.) and yields a BriefEvent every time
 * a new document or trigger arrives.
 *
 * Sibling registry to Grader / GroundingSource / Verifier / Destination.
 *
 * V1 ships zero default Sources; consumers register their own. The first
 * real adapter is `google-drive` (see src/source/google-drive.ts), driven
 * by the copy-pipeline-watch daemon.
 *
 * See ADR `docs/adr/0002-claim-verification.md` for the surrounding
 * pipeline architecture; this is the input-side complement to the
 * Destination adapter family.
 */

import type { BrandKit, Brief } from '../types.js'

export interface BriefSourceContext {
  /** Absolute path to the consumer project root. */
  workspaceRoot: string
  brandKit: BrandKit
}

/** One document / trigger that arrived at a Source. */
export interface BriefEvent {
  /** Stable identifier of the source document (e.g. Google Doc id, file path,
   *  webhook payload id). Used by the daemon to dedupe across restarts. */
  id: string
  /** Brief the pipeline runs. `text` is the operator-style instruction
   *  (typically supplied by Source config when the source is an existing
   *  document feed, e.g. "Apply the brand canonical to the following
   *  document and improve clarity + SEO."). */
  brief: Brief
  /** When the trigger is an existing document, the document body lands here.
   *  generate() switches to transform-mode when this is set: the model is
   *  asked to rewrite the source through the brand canonical rather than
   *  generate from scratch. */
  sourceDocument?: string
  /** Source-specific metadata (folder path, mime type, author, modified
   *  timestamp, ...). Surfaced in Langfuse traces + the BriefEvent log so
   *  operators can find the originating doc. */
  metadata: Record<string, unknown>
}

export interface BriefSource {
  /** Adapter identifier — must match brand-kit.input_sources.entries.<name>.adapter. */
  name: string
  /** Human description. */
  description?: string
  /**
   * Watch a feed for new documents. Implementations may poll, subscribe to
   * webhooks, or stream — the AsyncIterable abstracts the trigger model.
   * The daemon iterates this and drives the pipeline per event.
   */
  watch(args: {
    config: Record<string, unknown>
    ctx: BriefSourceContext
  }): AsyncIterable<BriefEvent>
  /**
   * Optional: fetch one document by id for manual reprocess / backfill.
   * When omitted, daemons can only consume the live watch stream.
   */
  fetchOne?(args: {
    id: string
    config: Record<string, unknown>
    ctx: BriefSourceContext
  }): Promise<BriefEvent>
}

export const INPUT_SOURCE_REGISTRY = new Map<string, BriefSource>()

export function registerInputSource(s: BriefSource): void {
  if (INPUT_SOURCE_REGISTRY.has(s.name)) {
    const existing = INPUT_SOURCE_REGISTRY.get(s.name)!
    throw new Error(
      `Duplicate input source for name '${s.name}': existing='${existing.description}'`,
    )
  }
  INPUT_SOURCE_REGISTRY.set(s.name, s)
}

/** Test/teardown helper. Not part of the public API contract. */
export function _clearInputSourceRegistry(): void {
  INPUT_SOURCE_REGISTRY.clear()
}

/**
 * Default BriefSource roster. V1 ships nothing — every consumer registers
 * the Source adapters that fit their workflow. The `google-drive` adapter
 * lives at `./google-drive.ts` and is opt-in.
 */
export async function defaultInputSources(): Promise<BriefSource[]> {
  return []
}
