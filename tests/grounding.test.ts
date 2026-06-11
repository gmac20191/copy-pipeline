/**
 * Integration tests for the pgvector grounding adapter.
 *
 * Gated by DATABASE_URL — when unset, the tests skip with a clear message
 * instead of failing. Local dev: `npm run stack:up` first.
 *
 * Covers:
 *   - Auto-create table on first write
 *   - Dimension mismatch error on subsequent write with a different embedder
 *   - write → retrieve roundtrip with deterministic embedder
 *   - Re-ingest replaces prior chunks for the same source_path
 *   - generate() picks up grounded chunks for a brief
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { generate } from '../src/generate.js'
import { resolveEmbedder } from '../src/grounding/embed.js'
import {
  _resetPgvectorPool,
  dropPgvectorTable,
  pgvectorSource,
} from '../src/grounding/pgvector.js'
import type { WritableChunk } from '../src/grounding/index.js'
import type { BrandKit } from '../src/types.js'

const DATABASE_URL = process.env['DATABASE_URL']
const HAS_DB = Boolean(DATABASE_URL)

// Skip the whole suite if no database — local dev needs `npm run stack:up`.
describe.skipIf(!HAS_DB)('pgvector grounding adapter (integration)', () => {
  const CORPUS = 'test_voice'
  const embedder = resolveEmbedder('test/det-128')

  beforeAll(async () => {
    // Ensure a clean slate.
    await dropPgvectorTable(CORPUS).catch(() => {})
  })

  afterEach(async () => {
    await dropPgvectorTable(CORPUS).catch(() => {})
  })

  afterAll(async () => {
    await _resetPgvectorPool()
  })

  const sampleChunk = (
    overrides: Partial<WritableChunk> = {},
  ): WritableChunk => ({
    id: 'post1#progressive-overload',
    text: 'Progressive overload is the principle that drives all training adaptation.',
    sourcePath: 'posts/coaching.md',
    breadcrumb: ['Training', 'Principles', 'Progressive Overload'],
    metadata: { tag: 'voice' },
    sourceHash: 'deadbeef',
    ...overrides,
  })

  it('auto-creates the table on first write', async () => {
    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: [sampleChunk()],
      embedder,
    })

    const retrieved = await pgvectorSource.retrieve({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      query: { text: 'how does training adaptation work?', topK: 5 },
      embedder,
    })

    expect(retrieved.length).toBeGreaterThan(0)
    expect(retrieved[0]!.text).toContain('Progressive overload')
  })

  it('write → retrieve roundtrip returns the closest chunk first', async () => {
    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: [
        sampleChunk({
          id: 'a',
          text: 'Sets and reps are the basic unit of training volume.',
          sourcePath: 'posts/volume.md',
        }),
        sampleChunk({
          id: 'b',
          text: 'Progressive overload drives muscle hypertrophy.',
          sourcePath: 'posts/overload.md',
        }),
        sampleChunk({
          id: 'c',
          text: 'Recovery between sessions matters more than the workout itself.',
          sourcePath: 'posts/recovery.md',
        }),
      ],
      embedder,
    })

    const retrieved = await pgvectorSource.retrieve({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      query: {
        text: 'Progressive overload drives muscle hypertrophy.',
        topK: 1,
      },
      embedder,
    })

    expect(retrieved.length).toBe(1)
    // Deterministic embedder: identical text produces the closest vector.
    expect(retrieved[0]!.text).toContain('Progressive overload')
    expect((retrieved[0]!.metadata as { id: string }).id).toBe('b')
  })

  it('re-ingest replaces prior chunks for the same source_path', async () => {
    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: [
        sampleChunk({
          id: 'old-1',
          text: 'old chunk one',
          sourcePath: 'p1.md',
        }),
        sampleChunk({
          id: 'old-2',
          text: 'old chunk two',
          sourcePath: 'p1.md',
        }),
      ],
      embedder,
    })

    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: [
        sampleChunk({ id: 'new', text: 'new chunk', sourcePath: 'p1.md' }),
      ],
      embedder,
    })

    const retrieved = await pgvectorSource.retrieve({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      query: { text: 'anything', topK: 10 },
      embedder,
    })

    const ids = retrieved.map((c) => (c.metadata as { id: string }).id)
    expect(ids).toEqual(['new'])
  })

  it('raises a clear error on dimension mismatch', async () => {
    const small = resolveEmbedder('test/det-128')
    const big = resolveEmbedder('test/det-256')

    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: [sampleChunk()],
      embedder: small,
    })

    await expect(
      pgvectorSource.write({
        corpusHandle: CORPUS,
        indexName: CORPUS,
        chunks: [sampleChunk({ id: 'other' })],
        embedder: big,
      }),
    ).rejects.toThrow(/dimension mismatch.*reindex/i)
  })

  it("emits an explanatory chunk when the corpus table doesn't exist", async () => {
    const retrieved = await pgvectorSource.retrieve({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      query: { text: 'anything', topK: 5 },
      embedder,
    })

    expect(retrieved.length).toBe(1)
    expect(retrieved[0]!.text).toMatch(/not yet indexed/)
    expect(retrieved[0]!.metadata).toMatchObject({ unindexed: true })
  })

  it('rejects unsafe index_name values', async () => {
    await expect(
      pgvectorSource.write({
        corpusHandle: 'ok',
        indexName: 'bad-name; drop table users;--',
        chunks: [sampleChunk()],
        embedder,
      }),
    ).rejects.toThrow(/must match/)
  })

  it('reindex (drop + recreate) returns the table to a working state', async () => {
    // Initial ingest.
    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: [sampleChunk({ id: 'before-drop', text: 'before drop' })],
      embedder,
    })

    // Drop the table (the reindex CLI flow).
    await dropPgvectorTable(CORPUS)

    // Re-ingest into the same corpus — the adapter should auto-create the
    // table again with the same dimension + HNSW index.
    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: [sampleChunk({ id: 'after-recreate', text: 'after recreate' })],
      embedder,
    })

    const retrieved = await pgvectorSource.retrieve({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      query: { text: 'after recreate', topK: 5 },
      embedder,
    })

    const ids = retrieved.map((c) => (c.metadata as { id: string }).id)
    expect(ids).toContain('after-recreate')
    // The pre-drop row is gone.
    expect(ids).not.toContain('before-drop')
  })

  it('reindex with a different-dimension embedder works after a drop', async () => {
    const small = resolveEmbedder('test/det-128')
    const big = resolveEmbedder('test/det-256')

    // Build with small.
    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: [sampleChunk()],
      embedder: small,
    })

    // Drop (operator's response to dimension mismatch error).
    await dropPgvectorTable(CORPUS)

    // Re-ingest with the larger embedder — should succeed now that the table
    // is gone (auto-create picks up the new dimension).
    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: [sampleChunk({ id: 'big' })],
      embedder: big,
    })

    const retrieved = await pgvectorSource.retrieve({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      query: { text: 'any', topK: 1 },
      embedder: big,
    })
    expect(retrieved).toHaveLength(1)
  })
})

describe.skipIf(!HAS_DB)(
  'generate() with pgvector grounding (integration)',
  () => {
    const CORPUS = 'test_gen_voice'
    const embedder = resolveEmbedder('test/det-128')

    beforeAll(async () => {
      await dropPgvectorTable(CORPUS).catch(() => {})
      await pgvectorSource.write({
        corpusHandle: CORPUS,
        indexName: CORPUS,
        chunks: [
          {
            id: 'seed-1',
            text: 'GROUND_TRUTH_MARKER: progressive overload is the central principle.',
            sourcePath: 'seed.md',
            breadcrumb: ['Seed'],
            metadata: {},
            sourceHash: 'seed',
          },
        ],
        embedder,
      })
    })

    afterAll(async () => {
      await dropPgvectorTable(CORPUS).catch(() => {})
      await _resetPgvectorPool()
    })

    const fixtureBrandKit = (): BrandKit => ({
      name: 'test-brand',
      version: '0.0.0',
      canonicals: {
        marketing: { spec: 'fixture://canonical' },
      },
      corpora: {
        voice: {
          backend: 'pgvector',
          index_name: CORPUS,
          status: 'active',
        },
      },
      models: {
        candidates: ['test/dim-128'],
        grader: 'test/grader',
        embedder: 'test/det-128',
      },
    })

    it('retrieves the seeded chunk and surfaces it in run.groundingChunks', async () => {
      const run = await generate({
        brief: {
          text: 'GROUND_TRUTH_MARKER: progressive overload is the central principle.',
          ground: ['voice'],
        },
        brandKit: fixtureBrandKit(),
      })

      expect(run.runId).toMatch(/^run_/)
      expect(run.groundingChunks.length).toBeGreaterThan(0)
      const chunkTexts = run.groundingChunks.map((c) => c.text).join('\n')
      expect(chunkTexts).toContain('GROUND_TRUTH_MARKER')

      // The system-prompt composition path is exercised internally by
      // generate() — buildSystemPrompt embeds run.groundingChunks into the
      // prompt sent to each candidate model. The model adapter returns an
      // explanatory stub when no API key is set, which keeps the test
      // hermetic.
    }, 30_000)
  },
)
