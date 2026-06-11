/**
 * Discovery-menu composer.
 *
 * Calls `discover()` on each registered Verifier (in parallel), unions
 * the results, and returns the menu used by the ClaimExtractor to
 * propose Evidence refs to the LLM. Per-verifier errors are swallowed
 * and surfaced as warnings — one failing verifier shouldn't block
 * extraction across the others.
 *
 * Verifiers without `discover()` (unbounded ref-spaces like
 * notebooklm-claim) are silently skipped — the LLM can still propose
 * refs for them; they're verified at runtime.
 */

import type {
  DiscoveredRef,
  Verifier,
  VerifierContext,
} from '../verifier/index.js'

export interface DiscoveryMenu {
  refs: DiscoveredRef[]
  warnings: string[]
}

export async function buildDiscoveryMenu(
  verifiers: Verifier[],
  ctx: VerifierContext,
): Promise<DiscoveryMenu> {
  const warnings: string[] = []

  const results = await Promise.all(
    verifiers
      .filter((v) => v.discover)
      .map(async (v) => {
        try {
          return await v.discover!(ctx)
        } catch (err) {
          warnings.push(
            `discover() failed for verifier '${v.name}' (prefix '${v.prefix}'): ${(err as Error).message}`,
          )
          return []
        }
      }),
  )

  return { refs: results.flat(), warnings }
}

/**
 * Render the discovery menu as a terse list for inclusion in the LLM
 * prompt. One ref per line; description appended when present.
 */
export function renderMenu(refs: DiscoveredRef[]): string {
  if (refs.length === 0) return '(no refs available)'
  return refs
    .map((r) => (r.description ? `${r.ref} — ${r.description}` : r.ref))
    .join('\n')
}
