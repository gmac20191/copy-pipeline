/**
 * Tests for the brand-agnostic Markdown ingester.
 *
 * Unit tests use temp directories; no external services. The
 * `(integration)` describe block hits pgvector and is gated by
 * DATABASE_URL.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resolveEmbedder } from '../src/grounding/embed.js'
import { ingestMarkdown } from '../src/grounding/ingest.js'
import {
  _resetPgvectorPool,
  dropPgvectorTable,
  pgvectorSource,
} from '../src/grounding/pgvector.js'

describe('ingestMarkdown (unit)', () => {
  it('emits no chunks for an empty directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-empty-'))
    const result = await ingestMarkdown({ source: dir })
    expect(result.chunks).toEqual([])
    expect(result.fileCount).toBe(0)
  })

  it('ingests a single file with frontmatter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-one-'))
    await writeFile(
      join(dir, 'post.md'),
      '---\ntitle: Hello\ntags: [voice]\n---\n\n## Greeting\n\nHello world.\n',
    )

    const result = await ingestMarkdown({ source: dir })
    expect(result.fileCount).toBe(1)
    expect(result.chunks).toHaveLength(1)

    const chunk = result.chunks[0]!
    expect(chunk.sourcePath).toBe('post.md')
    expect(chunk.breadcrumb).toEqual(['Greeting'])
    expect(chunk.text).toContain('Hello world.')
    expect(chunk.metadata).toMatchObject({ title: 'Hello', tags: ['voice'] })
  })

  it('computes stable ids of form <sourcePath>#<idx>', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-ids-'))
    await writeFile(
      join(dir, 'a.md'),
      '## Part A\n\nBody A.\n\n## Part B\n\nBody B.\n',
    )

    const result = await ingestMarkdown({ source: dir })
    expect(result.chunks.map((c) => c.id)).toEqual(['a.md#0', 'a.md#1'])
  })

  it('walks subdirectories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-walk-'))
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'root.md'), '## Root\n\nbody.\n')
    await writeFile(join(dir, 'sub', 'deep.md'), '## Deep\n\nbody.\n')

    const result = await ingestMarkdown({ source: dir })
    expect(result.fileCount).toBe(2)
    const paths = result.chunks.map((c) => c.sourcePath).sort()
    expect(paths).toEqual(['root.md', 'sub/deep.md'])
  })

  it('supports glob patterns to filter files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-glob-'))
    await mkdir(join(dir, 'keep'))
    await mkdir(join(dir, 'skip'))
    await writeFile(join(dir, 'keep', 'a.md'), '## A\nbody.\n')
    await writeFile(join(dir, 'skip', 'b.md'), '## B\nbody.\n')

    const result = await ingestMarkdown({ source: `${dir}/keep/*.md` })
    expect(result.fileCount).toBe(1)
    expect(result.chunks[0]!.sourcePath).toBe('a.md')
  })

  it('produces the same source_hash for the same file content across runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-hash-'))
    await writeFile(join(dir, 'a.md'), '## A\n\nstable.\n')
    const r1 = await ingestMarkdown({ source: dir })
    const r2 = await ingestMarkdown({ source: dir })
    expect(r1.chunks[0]!.sourceHash).toBe(r2.chunks[0]!.sourceHash)
  })

  it('ignores non-.md files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-mixed-'))
    await writeFile(join(dir, 'doc.md'), '## A\n\nbody.\n')
    await writeFile(join(dir, 'image.png'), 'not markdown')
    await writeFile(join(dir, 'readme.txt'), 'ignore me')

    const result = await ingestMarkdown({ source: dir })
    expect(result.fileCount).toBe(1)
    expect(result.chunks[0]!.sourcePath).toBe('doc.md')
  })

  it('rejects an unknown preset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-preset-'))
    await writeFile(join(dir, 'a.md'), '## A\nbody.\n')

    await expect(
      ingestMarkdown({
        source: dir,
        preset: 'nonexistent' as unknown as 'vanilla',
      }),
    ).rejects.toThrow(/preset "nonexistent"/)
  })
})

const HAS_DB = Boolean(process.env['DATABASE_URL'])

describe.skipIf(!HAS_DB)('ingest → write → retrieve (integration)', () => {
  const CORPUS = 'test_ingest_voice'
  const embedder = resolveEmbedder('test/det-128')

  beforeAll(async () => {
    await dropPgvectorTable(CORPUS).catch(() => {})
  })

  afterEach(async () => {
    await dropPgvectorTable(CORPUS).catch(() => {})
  })

  afterAll(async () => {
    await _resetPgvectorPool()
  })

  it('ingests a directory and retrieves chunks by similarity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-e2e-'))
    await writeFile(
      join(dir, 'training.md'),
      [
        '---',
        'topic: training',
        '---',
        '',
        '## Progressive Overload',
        '',
        'Progressive overload is the central principle of strength training.',
        '',
        '## Recovery',
        '',
        'Recovery is when adaptation happens.',
      ].join('\n'),
    )

    const result = await ingestMarkdown({ source: dir })
    expect(result.chunks).toHaveLength(2)

    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: result.chunks,
      embedder,
    })

    const retrieved = await pgvectorSource.retrieve({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      query: {
        text: 'Section: Progressive Overload\n\nProgressive overload is the central principle of strength training.',
        topK: 1,
      },
      embedder,
    })

    expect(retrieved).toHaveLength(1)
    expect(retrieved[0]!.text).toContain('Progressive overload')
    expect(
      (retrieved[0]!.metadata as { source_path: string }).source_path,
    ).toBe('training.md')
    expect(
      (retrieved[0]!.metadata as { breadcrumb: string[] }).breadcrumb,
    ).toEqual(['Progressive Overload'])
  })

  it("re-ingest replaces prior chunks when a source file's content changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-reingest-'))
    const file = join(dir, 'doc.md')
    await writeFile(file, '## A\n\nold body.\n')

    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: (await ingestMarkdown({ source: dir })).chunks,
      embedder,
    })

    await writeFile(file, '## A\n\nnew body.\n')
    await pgvectorSource.write({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      chunks: (await ingestMarkdown({ source: dir })).chunks,
      embedder,
    })

    const retrieved = await pgvectorSource.retrieve({
      corpusHandle: CORPUS,
      indexName: CORPUS,
      query: { text: 'any query', topK: 10 },
      embedder,
    })

    // Only one row should exist — the new one.
    expect(retrieved).toHaveLength(1)
    expect(retrieved[0]!.text).toContain('new body')
    expect(retrieved[0]!.text).not.toContain('old body')
  })
})
