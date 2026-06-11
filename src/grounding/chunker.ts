/**
 * Heading-based Markdown chunker.
 *
 * Pure function. Takes raw Markdown, returns chunks ready for embedding.
 * No filesystem, no DB, no async — just parse-and-split.
 *
 * Strategy per ADR 0001:
 *   - Boundary: H2 by default; fall back to H3 if an H2 section is too large;
 *     fall back to paragraph if H3 still too large.
 *   - Size: ~1000 tokens per chunk (char/4 heuristic — TARGET_CHARS = 4000).
 *   - Code blocks and tables are atomic — never split through a fence or
 *     table row, even if the chunk exceeds budget.
 *   - Breadcrumb (`H1 > H2 > H3`) is prepended to each chunk's `text` so the
 *     model and retriever both see the context.
 *   - No overlap.
 */

export interface ChunkOutput {
  /** Breadcrumb-prefixed text ready for embedding. */
  text: string
  /** Heading path, from H1 down to the chunk's dominant heading. */
  breadcrumb: string[]
}

const TARGET_CHARS = 4000

// ─── Block parser ────────────────────────────────────────────────────────────

type BlockKind = 'heading' | 'code' | 'table' | 'paragraph'

interface ParsedBlock {
  kind: BlockKind
  /** Only set when kind === "heading". 1-6. */
  level?: number
  /** Only set when kind === "heading". The title text without the # marks. */
  title?: string
  /** Raw lines of the block, joined with \n (no trailing newline). */
  text: string
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE_RE = /^(`{3,}|~{3,})/
const TABLE_ROW_RE = /^\s*\|/

export function parseMarkdownBlocks(markdown: string): ParsedBlock[] {
  const lines = markdown.split('\n')
  const blocks: ParsedBlock[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    // Skip blank lines between blocks.
    if (line.trim() === '') {
      i++
      continue
    }

    // Heading.
    const headingMatch = HEADING_RE.exec(line)
    if (headingMatch) {
      const level = headingMatch[1]!.length
      const title = headingMatch[2]!.trim()
      blocks.push({ kind: 'heading', level, title, text: line })
      i++
      continue
    }

    // Fenced code — consume until matching close fence.
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const fence = fenceMatch[1]!
      const codeLines: string[] = [line]
      i++
      while (i < lines.length) {
        const inner = lines[i]!
        codeLines.push(inner)
        if (inner.startsWith(fence)) {
          i++
          break
        }
        i++
      }
      blocks.push({ kind: 'code', text: codeLines.join('\n') })
      continue
    }

    // Table — consume contiguous `|...|` rows.
    if (TABLE_ROW_RE.test(line)) {
      const tableLines: string[] = []
      while (i < lines.length && TABLE_ROW_RE.test(lines[i] ?? '')) {
        tableLines.push(lines[i]!)
        i++
      }
      blocks.push({ kind: 'table', text: tableLines.join('\n') })
      continue
    }

    // Paragraph / list / blockquote — consume until blank line, fence, or heading.
    const paraLines: string[] = []
    while (i < lines.length) {
      const inner = lines[i]!
      if (inner.trim() === '') break
      if (HEADING_RE.test(inner)) break
      if (FENCE_RE.test(inner)) break
      paraLines.push(inner)
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: 'paragraph', text: paraLines.join('\n') })
    }
  }

  return blocks
}

// ─── Chunker ─────────────────────────────────────────────────────────────────

/**
 * Group parsed blocks into chunks. Headings update the breadcrumb but never
 * become chunks themselves (their text is embedded in the breadcrumb prefix
 * of the chunks that follow).
 */
export function chunkBlocks(
  blocks: ParsedBlock[],
  opts: { maxChars?: number } = {},
): ChunkOutput[] {
  const maxChars = opts.maxChars ?? TARGET_CHARS
  const chunks: ChunkOutput[] = []

  // Breadcrumb is indexed by level - 1 (H1 → index 0, H2 → 1, H3 → 2).
  // Max 6 levels. Updating a level clears all deeper levels.
  const breadcrumb: (string | undefined)[] = []

  let buffer: ParsedBlock[] = []

  function bufferChars(): number {
    return buffer.reduce((sum, b) => sum + b.text.length, 0)
  }

  function flush(): void {
    if (buffer.length === 0) return
    const bodyText = buffer.map((b) => b.text).join('\n\n')
    chunks.push({
      text: composeChunkText(currentBreadcrumb(), bodyText),
      breadcrumb: currentBreadcrumb(),
    })
    buffer = []
  }

  function currentBreadcrumb(): string[] {
    return breadcrumb.filter((s): s is string => Boolean(s))
  }

  for (const block of blocks) {
    if (block.kind === 'heading') {
      const lvl = block.level!
      // H2 starts a fresh chunk by default. H3 also splits when the current
      // buffer is already heavy. Higher levels just update the breadcrumb.
      const splitOn = lvl === 2 || (lvl === 3 && bufferChars() >= maxChars / 2)
      if (splitOn) {
        flush()
      }
      // Update breadcrumb.
      breadcrumb[lvl - 1] = block.title
      for (let j = lvl; j < breadcrumb.length; j++) breadcrumb[j] = undefined
      continue
    }

    // Non-heading block. Code + table are atomic — add wholesale.
    if (block.kind === 'code' || block.kind === 'table') {
      // If buffer is already past budget, flush first so this atomic block
      // gets its own chunk (won't be split anyway).
      if (bufferChars() >= maxChars) {
        flush()
      }
      buffer.push(block)
      continue
    }

    // Paragraphs: append. If we exceed budget, flush.
    buffer.push(block)
    if (bufferChars() >= maxChars) {
      flush()
    }
  }

  flush()
  return chunks
}

function composeChunkText(breadcrumb: string[], body: string): string {
  if (breadcrumb.length === 0) return body
  return `Section: ${breadcrumb.join(' > ')}\n\n${body}`
}

// ─── Convenience ─────────────────────────────────────────────────────────────

/**
 * Parse + chunk in one call. Most callers want this.
 */
export function chunkMarkdown(
  markdown: string,
  opts: { maxChars?: number } = {},
): ChunkOutput[] {
  const blocks = parseMarkdownBlocks(markdown)
  return chunkBlocks(blocks, opts)
}
