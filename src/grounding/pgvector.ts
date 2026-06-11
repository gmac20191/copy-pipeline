/**
 * pgvector GroundingSource adapter.
 *
 * Implements `retrieve` + `write` per ADR 0001. One table per corpus
 * (`chunks_<sanitized-index-name>`), dimension derived from the embedder
 * passed in at write time. Auto-creates the table + HNSW index on first
 * write; idempotent on subsequent writes.
 *
 * Connection comes from `DATABASE_URL` (env-only — brand-kit stays
 * infrastructure-agnostic). Graceful no-config: if `DATABASE_URL` is unset,
 * the adapter returns explanatory empty chunks so generate() still runs.
 *
 * Re-ingest semantics: writing chunks for a given `source_path` replaces
 * all prior chunks with the same `source_path` in the same atomic
 * transaction. Source files that shrink (chunks removed) lose their old
 * rows correctly.
 */

import pg from 'pg'
import pgvector from 'pgvector/pg'

import type {
  GroundingChunk,
  GroundingQuery,
  GroundingSource,
  WritableChunk,
} from './index.js'
import type { Embedder } from './embed.js'

const DEFAULT_TOP_K = 5

// ─── Connection pool (lazy) ──────────────────────────────────────────────────

let cachedPool: pg.Pool | null = null
let cachedPoolUrl: string | null = null

async function getPool(): Promise<pg.Pool | null> {
  const url = process.env['DATABASE_URL']
  if (!url) return null
  if (cachedPool && cachedPoolUrl === url) return cachedPool
  if (cachedPool) {
    await cachedPool.end().catch(() => {})
  }
  const pool = new pg.Pool({ connectionString: url })
  cachedPool = pool
  cachedPoolUrl = url
  return pool
}

/**
 * Acquire a client and register pgvector's type codecs synchronously before
 * returning. Replaces `pool.on('connect', ...)` which races with user queries
 * (pg 9 deprecates that pattern).
 */
async function acquire(pool: pg.Pool): Promise<pg.PoolClient> {
  const client = await pool.connect()
  await pgvector.registerType(client)
  return client
}

/** For tests — drop cached pool so subsequent calls reconnect cleanly. */
export async function _resetPgvectorPool(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end().catch(() => {})
  }
  cachedPool = null
  cachedPoolUrl = null
}

// ─── Table-name handling ─────────────────────────────────────────────────────

const SAFE_INDEX_NAME = /^[a-z][a-z0-9_]*$/

function tableNameFor(indexName: string): string {
  if (!SAFE_INDEX_NAME.test(indexName)) {
    throw new Error(
      `index_name "${indexName}" must match /^[a-z][a-z0-9_]*$/ — used as a Postgres table identifier`,
    )
  }
  return `chunks_${indexName}`
}

async function tableExists(
  client: pg.PoolClient,
  table: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = $1
     ) AS exists`,
    [table],
  )
  return result.rows[0]?.exists === true
}

async function ensureTable(
  client: pg.PoolClient,
  table: string,
  dimension: number,
): Promise<void> {
  // pgvector requires vector(N) at table-creation time. We inline the
  // sanitized table name + dimension here — both are validated above.
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id            TEXT PRIMARY KEY,
      text          TEXT NOT NULL,
      embedding     VECTOR(${dimension}) NOT NULL,
      source_path   TEXT NOT NULL,
      breadcrumb    TEXT[] NOT NULL DEFAULT '{}',
      metadata      JSONB NOT NULL DEFAULT '{}',
      source_hash   TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw ON ${table} USING hnsw (embedding vector_cosine_ops)`,
  )
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${table}_source_path ON ${table} (source_path)`,
  )
}

async function existingDimension(
  client: pg.PoolClient,
  table: string,
): Promise<number | null> {
  // pgvector exposes the column as `vector(N)` via format_type; parse N.
  const result = await client.query<{ formatted: string }>(
    `SELECT format_type(atttypid, atttypmod) AS formatted
       FROM pg_attribute
      WHERE attrelid = $1::regclass
        AND attname = 'embedding'`,
    [`public.${table}`],
  )
  const formatted = result.rows[0]?.formatted
  if (!formatted) return null
  const m = formatted.match(/vector\((\d+)\)/)
  return m && m[1] ? parseInt(m[1], 10) : null
}

// ─── Drop (used by the future `reindex` subcommand) ──────────────────────────

export async function dropPgvectorTable(indexName: string): Promise<void> {
  const pool = await getPool()
  if (!pool) {
    throw new Error('DATABASE_URL is not set — cannot drop corpus table')
  }
  const table = tableNameFor(indexName)
  await pool.query(`DROP TABLE IF EXISTS ${table}`)
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export const pgvectorSource: GroundingSource = {
  backend: 'pgvector',

  async retrieve(args: {
    corpusHandle: string
    indexName: string
    query: GroundingQuery
    embedder: Embedder
  }): Promise<GroundingChunk[]> {
    const { corpusHandle, indexName, query, embedder } = args
    const topK = query.topK ?? DEFAULT_TOP_K

    const pool = await getPool()
    if (!pool) {
      return [
        {
          source: corpusHandle,
          backend: 'pgvector',
          text: `[grounding skipped: DATABASE_URL not set]`,
          metadata: { skipped: true, reason: 'missing DATABASE_URL' },
        },
      ]
    }

    const table = tableNameFor(indexName)
    const client = await acquire(pool)
    try {
      if (!(await tableExists(client, table))) {
        return [
          {
            source: corpusHandle,
            backend: 'pgvector',
            text: `[corpus "${corpusHandle}" not yet indexed — run \`copy-pipeline index ${corpusHandle}\`]`,
            metadata: { unindexed: true, table },
          },
        ]
      }

      const [queryVector] = await embedder.embed([query.text])
      if (!queryVector) {
        return [
          {
            source: corpusHandle,
            backend: 'pgvector',
            text: `[embedder returned no vector for query]`,
            metadata: { failed: true, reason: 'empty embedding' },
          },
        ]
      }

      const result = await client.query<{
        id: string
        text: string
        source_path: string
        breadcrumb: string[]
        metadata: Record<string, unknown>
        distance: number
      }>(
        `SELECT id, text, source_path, breadcrumb, metadata,
                embedding <=> $1 AS distance
           FROM ${table}
          ORDER BY embedding <=> $1
          LIMIT $2`,
        [pgvector.toSql(queryVector), topK],
      )

      return result.rows.map((row) => ({
        source: corpusHandle,
        backend: 'pgvector',
        text: row.text,
        metadata: {
          id: row.id,
          source_path: row.source_path,
          breadcrumb: row.breadcrumb,
          distance: row.distance,
          ...row.metadata,
        },
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return [
        {
          source: corpusHandle,
          backend: 'pgvector',
          text: `[grounding failed for corpus "${corpusHandle}": ${msg}]`,
          metadata: { failed: true, error: msg, table },
        },
      ]
    } finally {
      client.release()
    }
  },

  async write(args: {
    corpusHandle: string
    indexName: string
    chunks: WritableChunk[]
    embedder: Embedder
  }): Promise<void> {
    const { indexName, chunks, embedder } = args
    if (chunks.length === 0) return

    const pool = await getPool()
    if (!pool) {
      throw new Error(
        'DATABASE_URL is not set — cannot write chunks. Run `npm run stack:up` first.',
      )
    }

    const table = tableNameFor(indexName)
    const client = await acquire(pool)
    try {
      // Dimension check — derive from embedder, compare to existing table if
      // present. Mismatch is the operator's signal to `reindex`.
      if (await tableExists(client, table)) {
        const existing = await existingDimension(client, table)
        if (existing !== null && existing !== embedder.dimension) {
          throw new Error(
            `dimension mismatch: table ${table} has dim ${existing}, ` +
              `embedder ${embedder.id} produces dim ${embedder.dimension}. ` +
              `Run \`copy-pipeline reindex ${args.corpusHandle}\` to drop + recreate.`,
          )
        }
      } else {
        await ensureTable(client, table, embedder.dimension)
      }

      // Batch-embed all chunk texts in one provider call.
      const vectors = await embedder.embed(chunks.map((c) => c.text))
      if (vectors.length !== chunks.length) {
        throw new Error(
          `embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
        )
      }

      // Re-ingest semantics: clear prior rows for any source_path in this
      // batch, then insert. Atomic. Files that shrink lose stale chunks.
      const sourcePaths = Array.from(new Set(chunks.map((c) => c.sourcePath)))

      await client.query('BEGIN')
      try {
        await client.query(
          `DELETE FROM ${table} WHERE source_path = ANY($1::text[])`,
          [sourcePaths],
        )

        // Per-row INSERT inside one transaction. pg natively serialises
        // JS string[] to text[] and JS objects to jsonb via JSON.stringify.
        const insertSql = `
          INSERT INTO ${table}
            (id, text, embedding, source_path, breadcrumb, metadata, source_hash)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE SET
            text = EXCLUDED.text,
            embedding = EXCLUDED.embedding,
            source_path = EXCLUDED.source_path,
            breadcrumb = EXCLUDED.breadcrumb,
            metadata = EXCLUDED.metadata,
            source_hash = EXCLUDED.source_hash
        `
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!
          const vector = vectors[i]!
          await client.query(insertSql, [
            chunk.id,
            chunk.text,
            pgvector.toSql(vector),
            chunk.sourcePath,
            chunk.breadcrumb,
            JSON.stringify(chunk.metadata),
            chunk.sourceHash,
          ])
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    } finally {
      client.release()
    }
  },
}
