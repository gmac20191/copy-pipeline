/**
 * `file:` verifier — checks a file path exists in the consumer workspace.
 *
 * Smallest possible Verifier. Brand-agnostic. Ships with copy-pipeline core.
 *
 * Ref format: `file:<relative-path-from-workspace-root>`
 * Examples:
 *   <claim ref="file:docs/brand/CANONICAL.md">...</claim>
 *   <claim ref="file:src/grader/brand-review.ts">...</claim>
 *
 * Discovery: globs the workspace for tracked files. Skips node_modules, dist,
 * and dot-directories. For very large workspaces (>10k files), consumers
 * should layer caching in their own verifiers rather than expecting this
 * one to scale.
 */

import { access } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import fg from 'fast-glob'
import type {
  Verifier,
  VerifyArgs,
  VerifyResult,
  VerifierContext,
  DiscoveredRef,
} from './index.js'

const DISCOVERY_GLOBS = ['**/*']
const DISCOVERY_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
]

async function verify(
  args: VerifyArgs,
  ctx: VerifierContext,
): Promise<VerifyResult> {
  const { ref } = args
  if (!ref || ref.includes('..')) {
    return {
      verdict: 'unverified',
      reason: `file ref must be a relative path inside the workspace, got '${ref}'`,
    }
  }

  const absolute = resolve(ctx.workspaceRoot, ref)
  const rel = relative(ctx.workspaceRoot, absolute)
  if (rel.startsWith('..')) {
    return {
      verdict: 'unverified',
      reason: `file ref escapes the workspace root: '${ref}'`,
    }
  }

  try {
    await access(absolute)
    return {
      verdict: 'verified',
      source: { uri: `file://${absolute}` },
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return {
        verdict: 'unverified',
        reason: `file does not exist: '${ref}'`,
        hint: `check the path is correct and relative to the workspace root`,
      }
    }
    return {
      verdict: 'error',
      message: `IO error checking '${ref}': ${(err as Error).message}`,
    }
  }
}

async function discover(ctx: VerifierContext): Promise<DiscoveredRef[]> {
  const paths = await fg(DISCOVERY_GLOBS, {
    cwd: ctx.workspaceRoot,
    ignore: DISCOVERY_IGNORE,
    onlyFiles: true,
    dot: false,
  })

  return paths.map((p) => ({
    ref: `file:${p}`,
  }))
}

export const fileVerifier: Verifier = {
  prefix: 'file',
  name: 'file',
  description: 'Checks that a file path exists in the consumer workspace',
  verify,
  discover,
}
