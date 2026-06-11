/**
 * brand-review grader.
 *
 * Shells out to the brand-review skill at ~/.claude/skills/brand-review/review.sh
 * with --json --paste, piping the variant text on stdin. Parses the resulting
 * findings + summary into the pipeline's Grader contract.
 *
 * This is the don't-duplicate-canonical principle in action: the rules live in
 * the skill (which reads them from the project's brand-kit per Phase 5a). The
 * pipeline does NOT re-implement rule scanning; it consumes the existing
 * deterministic check by subprocess.
 *
 * Score scheme:
 *   - blockers present  → 0.0 (would not ship)
 *   - warnings only     → 0.7
 *   - clean             → 1.0
 *
 * Failure modes are graceful: if the skill is missing or fails, the grader
 * returns a warning finding rather than throwing. The pipeline continues with
 * partial grading; the operator sees the grader was unavailable.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Grader, GraderResult } from './index.js'
import type { Finding } from '../types.js'

const BRAND_REVIEW_SCRIPT = join(
  homedir(),
  '.claude',
  'skills',
  'brand-review',
  'review.sh',
)

interface BrandReviewFinding {
  rule_id: string
  severity: 'blocker' | 'warning' | 'suggestion'
  group: string
  canonical_section: string
  file: string
  line: number
  column: number
  match: string
  rationale: string
}

interface BrandReviewJSONResult {
  target: string
  rules_source: 'brand-kit' | 'bundled'
  findings: BrandReviewFinding[]
  summary: {
    blockers: number
    warnings: number
    suggestions: number
  }
}

function runBrandReview(text: string): Promise<BrandReviewJSONResult> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(BRAND_REVIEW_SCRIPT, ['--json', '--paste'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('error', rejectP)
    proc.on('close', (code: number | null) => {
      // brand-review exits 1 when blockers present — still a successful "ran".
      if (code !== 0 && code !== 1) {
        rejectP(new Error(`brand-review exited ${code}: ${stderr.trim()}`))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as BrandReviewJSONResult
        resolveP(parsed)
      } catch (e) {
        rejectP(
          new Error(
            `failed to parse brand-review JSON: ${e instanceof Error ? e.message : String(e)}`,
          ),
        )
      }
    })
    proc.stdin.write(text)
    proc.stdin.end()
  })
}

export const brandReviewGrader: Grader = {
  name: 'brand-review',
  description:
    "Shells out to ~/.claude/skills/brand-review/review.sh --json --paste. Deterministic rule check (banned phrases, dead concepts, audience leaks, voice violations, AU spellings). Rules resolved from the project's brand-kit; falls back to bundled rules if no brand-kit found.",

  async grade(variant): Promise<GraderResult> {
    if (!existsSync(BRAND_REVIEW_SCRIPT)) {
      return {
        findings: [
          {
            graderName: 'brand-review',
            severity: 'warning',
            message: `brand-review skill not found at ${BRAND_REVIEW_SCRIPT}. Skipping deterministic rule check; install via ~/.claude/skills/brand-review/ or set up the project's brand-kit.`,
          },
        ],
        score: 0.5,
      }
    }

    try {
      const result = await runBrandReview(variant.text)
      const findings: Finding[] = result.findings.map((f) => ({
        graderName: 'brand-review',
        severity: f.severity,
        message: `[${f.rule_id}] "${f.match}" — canonical ${f.canonical_section}${f.rationale ? ` (${f.rationale})` : ''}`,
        detail: { ...f, rules_source: result.rules_source },
      }))

      const hasBlocker = result.summary.blockers > 0
      const hasWarning = result.summary.warnings > 0
      const score = hasBlocker ? 0 : hasWarning ? 0.7 : 1.0

      return { findings, score }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      return {
        findings: [
          {
            graderName: 'brand-review',
            severity: 'warning',
            message: `brand-review invocation failed: ${msg}`,
          },
        ],
        score: 0.5,
      }
    }
  },
}
