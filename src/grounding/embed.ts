/**
 * Embedder resolver.
 *
 * Reads `brandKit.models.embedder` and returns an `Embedder` capable of
 * batch-embedding strings into Float32 vectors. The brand-kit field is the
 * contract — copy-pipeline doesn't hardcode a provider per ADR 0001.
 *
 * Supported provider prefixes (V1):
 *   - `openai/<model>` — calls OpenAI's embeddings API. Reads `OPENAI_API_KEY`.
 *     Example: `openai/text-embedding-3-small` (default, 1536 dim).
 *
 * Future providers (Voyage, Cohere, local) plug in by adding another
 * recognised prefix. The brand-kit string stays the same shape:
 * `<provider>/<model>`.
 *
 * The embedder also reports its `dimension`. The pgvector adapter uses this
 * at table-creation time to size the vector column. A dimension mismatch on
 * subsequent writes is the operator's signal to `reindex` the corpus.
 */

import { createHash } from 'node:crypto'

import OpenAI from 'openai'

export interface Embedder {
  /** Provider/model string, e.g. "openai/text-embedding-3-small". */
  readonly id: string
  /** Output vector dimension. */
  readonly dimension: number
  /** Batch-embed N strings; returns N vectors in matching order. */
  embed(texts: string[]): Promise<number[][]>
}

export const DEFAULT_EMBEDDER_ID = 'openai/text-embedding-3-small'

const OPENAI_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
}

/**
 * Build an Embedder from a brand-kit's `models.embedder` field.
 * Falls back to DEFAULT_EMBEDDER_ID when the field is undefined.
 */
export function resolveEmbedder(spec: string | undefined): Embedder {
  const id = spec ?? DEFAULT_EMBEDDER_ID
  const slash = id.indexOf('/')
  if (slash === -1) {
    throw new Error(
      `embedder id "${id}" must be of form "<provider>/<model>" (e.g. "openai/text-embedding-3-small")`,
    )
  }
  const provider = id.slice(0, slash)
  const model = id.slice(slash + 1)

  switch (provider) {
    case 'openai':
      return makeOpenAIEmbedder(id, model)
    case 'test':
      // Internal: deterministic hash-based embedder, only reached when a
      // brand-kit explicitly declares `test/det-<dim>`. Production use would
      // be surprising — pgvector retrieval against real text would be
      // semantically meaningless. Lives here so integration tests can run
      // without OPENAI_API_KEY.
      return makeDeterministicEmbedder(id, model)
    default:
      throw new Error(
        `unknown embedder provider "${provider}" in "${id}". Supported: openai. ` +
          `Add another provider by extending src/grounding/embed.ts.`,
      )
  }
}

function makeDeterministicEmbedder(id: string, model: string): Embedder {
  const match = model.match(/^det-(\d+)$/)
  if (!match || !match[1]) {
    throw new Error(
      `test embedder must be of form "test/det-<dim>" (e.g. "test/det-128"); got "${id}"`,
    )
  }
  const dim = parseInt(match[1], 10)
  return {
    id,
    dimension: dim,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => textToVector(text, dim))
    },
  }
}

function textToVector(text: string, dim: number): number[] {
  const vector: number[] = []
  let counter = 0
  while (vector.length < dim) {
    const h = createHash('sha256').update(`${counter}\n${text}`).digest()
    for (let i = 0; i < h.length && vector.length < dim; i += 2) {
      vector.push(h.readInt16BE(i) / 32768)
    }
    counter++
  }
  const norm = Math.sqrt(vector.reduce((a, b) => a + b * b, 0))
  if (norm === 0) return vector
  return vector.map((v) => v / norm)
}

function makeOpenAIEmbedder(id: string, model: string): Embedder {
  const dimension = OPENAI_DIMENSIONS[model]
  if (dimension === undefined) {
    throw new Error(
      `unknown OpenAI embedding model "${model}". Known: ${Object.keys(OPENAI_DIMENSIONS).join(', ')}. ` +
        `Add it to OPENAI_DIMENSIONS in src/grounding/embed.ts if it's supported by OpenAI.`,
    )
  }

  let cachedClient: OpenAI | null = null
  function client(): OpenAI {
    if (!cachedClient) {
      const apiKey = process.env['OPENAI_API_KEY']
      if (!apiKey) {
        throw new Error(
          `OPENAI_API_KEY is not set — embedder "${id}" cannot run. ` +
            `Set the env var, or switch brand-kit's models.embedder to a different provider.`,
        )
      }
      cachedClient = new OpenAI({ apiKey })
    }
    return cachedClient
  }

  return {
    id,
    dimension,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []
      const response = await client().embeddings.create({
        model,
        input: texts,
      })
      // Preserve input order — OpenAI's API guarantees `data[i].index === i`
      // but we sort defensively to avoid silent corruption if that ever
      // changes.
      const sorted = [...response.data].sort((a, b) => a.index - b.index)
      return sorted.map((d) => d.embedding)
    },
  }
}
