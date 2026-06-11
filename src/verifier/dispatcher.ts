/**
 * Claim-tag dispatcher.
 *
 * Parses `<claim ref="prefix:body">text</claim>` HTML-passthrough tags from
 * markdown, routes each by prefix to a registered Verifier, and returns
 * per-claim verdicts plus aggregate counts. The reserved `needs-evidence:`
 * prefix is handled directly without dispatching to a Verifier.
 *
 * The CI gate uses the aggregate counts to decide block / warn / allow:
 *  - any `unverified` → block (claim was checked and failed)
 *  - any `needsEvidence` → warn or block per consumer policy
 *  - all `error` → warn, allow (transient)
 *
 * See ADR `docs/adr/0002-claim-verification.md`.
 */

import {
  VERIFIER_REGISTRY,
  NEEDS_EVIDENCE_PREFIX,
  type Verifier,
  type VerifierContext,
  type VerifyResult,
  type EvidenceRef,
} from './index.js'

/** One claim parsed out of source markdown. */
export interface ParsedClaim {
  /** Full ref including prefix, e.g. `eval:stress-driver-fcq-down`. */
  rawRef: EvidenceRef
  /** Prose between the opening and closing tag. */
  text: string
  /** Character span in the source text [start, end). */
  span: [number, number]
  /**
   * Every key=value attribute parsed off the opening tag, including `ref`.
   * Verifiers don't consume this directly (they get `ref`), but downstream
   * trace persisters use attrs.id (or other presentation metadata) to key
   * per-claim audit files.
   */
  attrs: Record<string, string>
}

/** A claim's verdict after dispatching. Includes the dispatcher-only
 * `needs-evidence` shape distinct from the Verifier's own VerifyResult. */
export type ClaimVerdict = VerifyResult | { verdict: 'needs-evidence' }

export interface VerifiedClaim {
  rawRef: EvidenceRef
  text: string
  span: [number, number]
  verdict: ClaimVerdict
  /** All key=value attributes on the opening tag (including `ref`). Lets
   *  downstream trace persisters key per-claim audit files by `attrs.id`. */
  attrs: Record<string, string>
}

export interface VerificationReport {
  claims: VerifiedClaim[]
  counts: {
    verified: number
    unverified: number
    error: number
    needsEvidence: number
    total: number
  }
}

export interface VerifyClaimsOptions {
  /**
   * Override the registered Verifier set. When omitted, the dispatcher
   * uses the global `VERIFIER_REGISTRY`.
   */
  verifiers?: Verifier[]
}

/**
 * Matches `<claim ...>text</claim>` HTML passthrough tags. Captures the full
 * attribute string and the body separately; `ref` is then extracted by a
 * second pass over the attribute string. This shape tolerates consumer-side
 * presentation attrs (e.g. `author`, `year`, `title`) alongside `ref` —
 * Verifiers ignore everything but `ref`.
 *
 * Double quotes only in v1; non-greedy body match so adjacent claims don't
 * merge. Does not support nesting — a `<claim>` cannot contain another
 * `<claim>`.
 */
const CLAIM_TAG_RE = /<claim\s+([^>]+?)\s*>([\s\S]*?)<\/claim>/g
const REF_ATTR_RE = /\bref="([^"]+)"/
const ATTR_RE = /(\w+)="([^"]*)"/g

function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of attrString.matchAll(ATTR_RE)) {
    attrs[m[1]!] = m[2]!
  }
  return attrs
}

export function parseClaims(text: string): ParsedClaim[] {
  const claims: ParsedClaim[] = []
  for (const match of text.matchAll(CLAIM_TAG_RE)) {
    if (match.index === undefined) continue
    const attrString = match[1]!
    const refMatch = REF_ATTR_RE.exec(attrString)
    if (!refMatch) continue
    claims.push({
      rawRef: refMatch[1]!,
      text: match[2]!,
      span: [match.index, match.index + match[0].length],
      attrs: parseAttrs(attrString),
    })
  }
  return claims
}

function prefixOf(ref: EvidenceRef): string | undefined {
  const idx = ref.indexOf(':')
  return idx === -1 ? undefined : ref.slice(0, idx)
}

function bodyOf(ref: EvidenceRef): string {
  const idx = ref.indexOf(':')
  return idx === -1 ? '' : ref.slice(idx + 1)
}

function resolveVerifiers(override?: Verifier[]): Map<string, Verifier> {
  if (!override) return VERIFIER_REGISTRY
  const map = new Map<string, Verifier>()
  for (const v of override) map.set(v.prefix, v)
  return map
}

/**
 * Verify every `<claim>` tag in `text` against the registered Verifiers.
 */
export async function verifyClaims(
  text: string,
  ctx: VerifierContext,
  options: VerifyClaimsOptions = {},
): Promise<VerificationReport> {
  const claims = parseClaims(text)
  const verifiers = resolveVerifiers(options.verifiers)

  const verified = await Promise.all(
    claims.map(async (c): Promise<VerifiedClaim> => {
      // needs-evidence is the reserved sentinel for "ClaimExtractor couldn't
      // match a ref" — body is informational, may be omitted.
      if (
        c.rawRef === NEEDS_EVIDENCE_PREFIX ||
        c.rawRef.startsWith(`${NEEDS_EVIDENCE_PREFIX}:`)
      ) {
        return { ...c, verdict: { verdict: 'needs-evidence' } }
      }

      const prefix = prefixOf(c.rawRef)

      if (!prefix) {
        return {
          ...c,
          verdict: {
            verdict: 'unverified',
            reason: `malformed ref: missing prefix in '${c.rawRef}'`,
            hint: 'refs must look like "prefix:body" (e.g. "file:docs/foo.md")',
          },
        }
      }

      const verifier = verifiers.get(prefix)
      if (!verifier) {
        return {
          ...c,
          verdict: {
            verdict: 'unverified',
            reason: `no verifier registered for prefix '${prefix}'`,
            hint: `register a Verifier for '${prefix}' at consumer startup, or change the ref`,
          },
        }
      }

      try {
        const result = await verifier.verify(
          { claim: c.text, ref: bodyOf(c.rawRef), rawRef: c.rawRef },
          ctx,
        )
        return { ...c, verdict: result }
      } catch (err) {
        return {
          ...c,
          verdict: {
            verdict: 'error',
            message: `verifier '${verifier.name}' threw: ${(err as Error).message}`,
          },
        }
      }
    }),
  )

  const counts = {
    verified: 0,
    unverified: 0,
    error: 0,
    needsEvidence: 0,
    total: verified.length,
  }
  for (const v of verified) {
    if (v.verdict.verdict === 'verified') counts.verified++
    else if (v.verdict.verdict === 'unverified') counts.unverified++
    else if (v.verdict.verdict === 'error') counts.error++
    else counts.needsEvidence++
  }

  return { claims: verified, counts }
}
