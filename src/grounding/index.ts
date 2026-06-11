/**
 * GroundingSource interface.
 *
 * Each named corpus handle in brand-kit's `corpora` block has a `backend` field
 * (e.g. "pgvector") that maps to a registered GroundingSource. The pipeline
 * routes per-call corpus selection through the right backend.
 *
 * V1 ships with:
 * - `pgvector` — Postgres + pgvector adapter
 *
 * Sibling use cases (tech-doc grounding from OpenAPI / ts-morph / process
 * stdout) plug in additional GroundingSource implementations via the same
 * interface. See `docs/adr/0001-grounding-stack.md`.
 */

import type { GroundingChunk } from '../types.js'
import type { Embedder } from './embed.js'

// Re-export so adapter implementations can pull both the interface + chunk
// shape from one import location.
export type { GroundingChunk } from '../types.js'

export interface GroundingQuery {
  /** The brief text or a derived query string. */
  text: string
  /** Max chunks to return. */
  topK?: number
}

/**
 * A chunk ready to be embedded + persisted. Produced by the Markdown
 * ingester; consumed by `GroundingSource.write`.
 */
export interface WritableChunk {
  /** Globally unique chunk id, e.g. `voice/posts/coaching.md#progressive-overload`. */
  id: string
  /** The text the model will see at retrieval (already includes breadcrumb prefix). */
  text: string
  /** Relative path of the source file. Used to replace prior chunks on re-ingest. */
  sourcePath: string
  /** Heading path the chunk came from, e.g. ["Installation", "Linux", "Prerequisites"]. */
  breadcrumb: string[]
  /** Frontmatter + any other parser-emitted metadata. */
  metadata: Record<string, unknown>
  /** SHA-256 of the source file content at ingest time. */
  sourceHash: string
}

export interface GroundingSource {
  /** Backend identifier. Must match brand-kit.corpora.<handle>.backend. */
  backend: string
  /**
   * Retrieve chunks relevant to the query.
   */
  retrieve(args: {
    corpusHandle: string
    indexName: string
    query: GroundingQuery
    embedder: Embedder
  }): Promise<GroundingChunk[]>
  /**
   * Persist chunks for a corpus. The adapter embeds via the supplied embedder
   * and writes to its backend. Re-running write for the same source_paths
   * replaces previous chunks for those paths.
   */
  write(args: {
    corpusHandle: string
    indexName: string
    chunks: WritableChunk[]
    embedder: Embedder
  }): Promise<void>
}

export const GROUNDING_REGISTRY = new Map<string, GroundingSource>()

export function registerGroundingSource(s: GroundingSource): void {
  GROUNDING_REGISTRY.set(s.backend, s)
}

/**
 * Default grounding source roster. V0.2.0 ships the pgvector adapter.
 * Pass a custom array to `generate({ groundingSources: ... })` to override.
 */
export async function defaultGroundingSources(): Promise<GroundingSource[]> {
  const { pgvectorSource } = await import('./pgvector.js')
  return [pgvectorSource]
}
