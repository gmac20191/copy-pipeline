/**
 * Brand-agnostic Markdown ingester.
 *
 * Walks a directory or glob of `.md` files, parses YAML/TOML frontmatter via
 * gray-matter, hands the body to the chunker, and emits `WritableChunk[]`
 * ready for `GroundingSource.write`.
 *
 * Source-format quirks (Hugo shortcodes, MDX, etc.) are handled by the
 * `preset` arg per ADR 0001. V1 ships `vanilla` only; the `hugo` preset
 * ships in issue #4 of the grounding-stack epic.
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import fg from 'fast-glob'
import matter from 'gray-matter'

import { chunkMarkdown } from './chunker.js'
import type { WritableChunk } from './index.js'
import { resolvePreset, type IngestPreset } from './presets/index.js'

export type { IngestPreset } from './presets/index.js'

export interface IngestOptions {
  /** Directory path or glob pattern. Directories implicitly match `**\/*.md`. */
  source: string
  /** Override per-chunk char budget (default 4000 ≈ 1000 tokens). */
  maxChars?: number
  /** Source-format preprocessor. Default "vanilla" (no transformation). */
  preset?: IngestPreset
}

export interface IngestResult {
  chunks: WritableChunk[]
  fileCount: number
  bytesRead: number
}

export async function ingestMarkdown(
  opts: IngestOptions,
): Promise<IngestResult> {
  const { source, maxChars } = opts
  const { pattern, baseDir } = await resolvePattern(source)
  const files = await fg(pattern, { onlyFiles: true, absolute: true })
  files.sort()

  const chunks: WritableChunk[] = []
  let bytesRead = 0

  for (const filePath of files) {
    const raw = await readFile(filePath, 'utf-8')
    bytesRead += raw.length

    const parsed = matter(raw)
    const sourcePath = relative(baseDir, filePath)
    const sourceHash = createHash('sha256').update(raw).digest('hex')

    const body = resolvePreset(opts.preset ?? 'vanilla')(parsed.content)
    const fileChunks = chunkMarkdown(
      body,
      maxChars !== undefined ? { maxChars } : {},
    )

    for (let i = 0; i < fileChunks.length; i++) {
      const c = fileChunks[i]!
      chunks.push({
        id: `${sourcePath}#${i}`,
        text: c.text,
        sourcePath,
        breadcrumb: c.breadcrumb,
        metadata: parsed.data as Record<string, unknown>,
        sourceHash,
      })
    }
  }

  return { chunks, fileCount: files.length, bytesRead }
}

/**
 * Resolve a directory or glob into a (pattern, baseDir) pair fast-glob can
 * use. Directory inputs implicitly become `<dir>/**\/*.md`.
 */
async function resolvePattern(
  source: string,
): Promise<{ pattern: string; baseDir: string }> {
  const abs = resolve(source)

  // If source has no glob metacharacters AND is a directory, expand it.
  if (!hasGlobChars(source)) {
    try {
      const st = await stat(abs)
      if (st.isDirectory()) {
        return { pattern: `${abs}/**/*.md`, baseDir: abs }
      }
      if (st.isFile()) {
        // Single file: baseDir = its directory.
        const { dirname } = await import('node:path')
        return { pattern: abs, baseDir: dirname(abs) }
      }
    } catch {
      // Doesn't exist — fall through and let fast-glob produce []
    }
  }

  // Glob pattern: baseDir = everything before the first glob char.
  const globIdx = source.search(/[*?[{]/)
  const baseRaw = globIdx === -1 ? source : source.slice(0, globIdx)
  const baseDir = resolve(baseRaw)
  return { pattern: abs, baseDir }
}

function hasGlobChars(s: string): boolean {
  return /[*?[{]/.test(s)
}
