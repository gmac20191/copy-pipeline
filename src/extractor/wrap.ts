/**
 * Claim wrapping.
 *
 * Takes raw extracted claims (verbatim prose + proposed ref) and inserts
 * `<claim ref="...">...</claim>` tags around each match in the source
 * text. Pure function — no LLM, no IO. Testable in isolation.
 *
 * Strategy:
 * 1. For each claim, locate its first unused occurrence in the source.
 * 2. Record the [start, end) span.
 * 3. Apply replacements in reverse order so earlier spans aren't shifted
 *    by later insertions.
 * 4. Emit warnings for: claim text not found, overlapping spans.
 *
 * Overlap policy v1: if two claims' spans overlap, the second (in the
 * input claim order) is dropped with a warning. Authors / LLMs should
 * avoid emitting overlapping claims; we don't try to nest tags.
 */

import type { ExtractedClaim } from './index.js'
import type { EvidenceRef } from '../verifier/index.js'

export interface WrapResult {
  text: string
  warnings: string[]
}

interface Span {
  start: number
  end: number
  ref: EvidenceRef
  rawText: string
}

function escapeAttribute(s: string): string {
  // refs use a constrained character set in practice (slugs, paths,
  // colons, slashes, dots, hashes) — but defensive against the LLM
  // returning quotes inside the ref string.
  return s.replace(/"/g, '&quot;')
}

function findUnusedOccurrence(
  source: string,
  needle: string,
  usedStarts: Set<number>,
): number {
  if (needle.length === 0) return -1
  let from = 0
  while (true) {
    const idx = source.indexOf(needle, from)
    if (idx === -1) return -1
    if (!usedStarts.has(idx)) return idx
    from = idx + 1
  }
}

function spansOverlap(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

export function wrapClaims(
  source: string,
  claims: ExtractedClaim[],
): WrapResult {
  const warnings: string[] = []
  const spans: Span[] = []
  const usedStarts = new Set<number>()

  for (const c of claims) {
    if (c.text.length === 0) {
      warnings.push(`empty claim text (ref='${c.ref}')`)
      continue
    }
    const idx = findUnusedOccurrence(source, c.text, usedStarts)
    if (idx === -1) {
      const preview = c.text.length > 60 ? `${c.text.slice(0, 60)}…` : c.text
      warnings.push(`claim text not found in variant: "${preview}"`)
      continue
    }
    const span: Span = {
      start: idx,
      end: idx + c.text.length,
      ref: c.ref,
      rawText: c.text,
    }
    const conflict = spans.find((s) => spansOverlap(s, span))
    if (conflict) {
      const preview = c.text.length > 60 ? `${c.text.slice(0, 60)}…` : c.text
      warnings.push(
        `claim "${preview}" overlaps an earlier claim with ref '${conflict.ref}'; dropped`,
      )
      continue
    }
    spans.push(span)
    usedStarts.add(idx)
  }

  // Apply in reverse so earlier indices stay valid.
  spans.sort((a, b) => b.start - a.start)
  let output = source
  for (const s of spans) {
    const wrapped = `<claim ref="${escapeAttribute(s.ref)}">${s.rawText}</claim>`
    output = output.slice(0, s.start) + wrapped + output.slice(s.end)
  }

  return { text: output, warnings }
}
