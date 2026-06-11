/**
 * Unit tests for the heading-based Markdown chunker.
 * Pure function — no fixtures on disk, no DB.
 */

import { describe, expect, it } from 'vitest'

import {
  chunkBlocks,
  chunkMarkdown,
  parseMarkdownBlocks,
} from '../src/grounding/chunker.js'

describe('parseMarkdownBlocks', () => {
  it('parses an empty doc as no blocks', () => {
    expect(parseMarkdownBlocks('')).toEqual([])
    expect(parseMarkdownBlocks('\n\n\n')).toEqual([])
  })

  it('recognises ATX headings at levels 1-6', () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6'
    const blocks = parseMarkdownBlocks(md)
    expect(blocks).toHaveLength(6)
    for (let i = 0; i < 6; i++) {
      expect(blocks[i]!.kind).toBe('heading')
      expect(blocks[i]!.level).toBe(i + 1)
      expect(blocks[i]!.title).toBe(`H${i + 1}`)
    }
  })

  it('treats fenced code as a single atomic block', () => {
    const md = [
      '## A',
      '',
      '```ts',
      '# not a heading',
      'x = 1',
      '```',
      '',
      '## B',
    ].join('\n')
    const blocks = parseMarkdownBlocks(md)
    const codeBlock = blocks.find((b) => b.kind === 'code')
    expect(codeBlock).toBeDefined()
    expect(codeBlock!.text).toContain('# not a heading')
    expect(codeBlock!.text).toContain('x = 1')
    // The "# not a heading" line should NOT have been split out as a heading.
    const headings = blocks.filter((b) => b.kind === 'heading')
    expect(headings.map((h) => h.title)).toEqual(['A', 'B'])
  })

  it('treats tables as atomic blocks', () => {
    const md = ['## table', '', '| a | b |', '| - | - |', '| 1 | 2 |'].join(
      '\n',
    )
    const blocks = parseMarkdownBlocks(md)
    const table = blocks.find((b) => b.kind === 'table')
    expect(table).toBeDefined()
    expect(table!.text).toContain('| 1 | 2 |')
  })
})

describe('chunkBlocks + chunkMarkdown', () => {
  it('produces no chunks for an empty doc', () => {
    expect(chunkMarkdown('')).toEqual([])
  })

  it('produces one chunk with empty breadcrumb when there are no headings', () => {
    const chunks = chunkMarkdown('Just a paragraph with no heading above it.')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.breadcrumb).toEqual([])
    expect(chunks[0]!.text).toContain('Just a paragraph')
  })

  it('emits one chunk per H2 section by default', () => {
    const md = [
      '# Doc',
      '',
      '## First',
      'First section body.',
      '',
      '## Second',
      'Second section body.',
      '',
      '## Third',
      'Third section body.',
    ].join('\n')
    const chunks = chunkMarkdown(md)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.breadcrumb).toEqual(['Doc', 'First'])
    expect(chunks[1]!.breadcrumb).toEqual(['Doc', 'Second'])
    expect(chunks[2]!.breadcrumb).toEqual(['Doc', 'Third'])
  })

  it('prefixes each chunk with its breadcrumb', () => {
    const md = '# Doc\n\n## Section\n\nBody text.'
    const chunks = chunkMarkdown(md)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toMatch(/^Section: Doc > Section\n\n/)
    expect(chunks[0]!.text).toContain('Body text.')
  })

  it('clears deeper breadcrumb levels when a higher-level heading appears', () => {
    const md = [
      '# Doc',
      '## A',
      '### A1',
      'Body of A1.',
      '## B',
      'Body of B.',
    ].join('\n')
    const chunks = chunkMarkdown(md)
    const bChunk = chunks.find((c) => c.text.includes('Body of B'))
    expect(bChunk).toBeDefined()
    expect(bChunk!.breadcrumb).toEqual(['Doc', 'B'])
    // No leftover "A1" from the prior subsection.
    expect(bChunk!.breadcrumb).not.toContain('A1')
  })

  it('keeps code blocks atomic even if oversized', () => {
    const longCode = '```ts\n' + 'x = 1\n'.repeat(2000) + '```'
    const md = `## section\n\n${longCode}`
    const chunks = chunkMarkdown(md, { maxChars: 500 })
    expect(chunks).toHaveLength(1)
    // The code block survived intact — no splits through fences.
    expect(chunks[0]!.text).toContain('```ts')
    expect(chunks[0]!.text).toMatch(/```$/)
  })

  it('falls back to H3 boundaries when an H2 section exceeds budget', () => {
    const fillParagraph = 'x '.repeat(800) // ~1600 chars
    const md = [
      '## Big',
      '### Part 1',
      fillParagraph,
      '### Part 2',
      fillParagraph,
      '### Part 3',
      fillParagraph,
    ].join('\n\n')
    const chunks = chunkMarkdown(md, { maxChars: 1000 })
    // Should split per Part, not concatenate everything into one giant chunk.
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    const breadcrumbs = chunks.map((c) => c.breadcrumb.join(' > '))
    expect(breadcrumbs.some((b) => b.includes('Part 1'))).toBe(true)
    expect(breadcrumbs.some((b) => b.includes('Part 2'))).toBe(true)
    expect(breadcrumbs.some((b) => b.includes('Part 3'))).toBe(true)
  })

  it('ignores headings that appear inside fenced code blocks', () => {
    const md = [
      '## real',
      '',
      '```',
      '## not a heading',
      'still inside the fence',
      '```',
      '',
      '## also real',
      '',
      'trailing body.',
    ].join('\n')
    const chunks = chunkMarkdown(md)
    const breadcrumbs = chunks.map((c) => c.breadcrumb.join(' > '))
    expect(breadcrumbs).toEqual(['real', 'also real'])
    // The fake-heading line inside the fence is preserved as code, not as a
    // heading that split the doc.
    expect(chunks[0]!.text).toContain('## not a heading')
  })

  it('produces no chunks for a heading-only doc', () => {
    const md = '# Doc\n## Empty Section\n## Another Empty'
    expect(chunkMarkdown(md)).toEqual([])
  })

  it('can call chunkBlocks directly', () => {
    const blocks = parseMarkdownBlocks('## A\nBody.')
    const chunks = chunkBlocks(blocks)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.breadcrumb).toEqual(['A'])
  })
})
