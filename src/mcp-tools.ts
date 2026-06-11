/**
 * MCP tool handlers, factored out of bin/copy-pipeline-mcp.ts so they're
 * testable without spawning the MCP server.
 *
 * Each handler takes its dependencies as explicit parameters (workspaceRoot,
 * brandKit, verifier list) rather than reading from process globals. The
 * MCP server entry point in bin/ wires the globals through; tests pass
 * stubs.
 */

import type { BrandKit, Verifier, VerifierContext } from './index.js'
import { verifyClaims, type VerificationReport } from './verifier/dispatcher.js'
import { buildDiscoveryMenu, type DiscoveryMenu } from './extractor/menu.js'

/**
 * MCP CallToolResult shape — minimal subset we produce. Defined locally so
 * src/ doesn't depend on the MCP SDK at compile time (the SDK is only
 * needed in bin/).
 */
export interface ToolResult {
  content: { type: 'text'; text: string }[]
  structuredContent: Record<string, unknown>
}

export interface ToolContext {
  workspaceRoot: string
  brandKit: BrandKit
  /** Verifier set used by tools that route through the dispatcher. When
   * omitted, the dispatcher uses the global VERIFIER_REGISTRY. */
  verifiers?: Verifier[]
}

function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: (value ?? {}) as Record<string, unknown>,
  }
}

/** Parse <claim> tags from a markdown string and verify each. */
export async function toolVerifyClaims(
  text: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const verifyCtx: VerifierContext = {
    workspaceRoot: ctx.workspaceRoot,
    brandKit: ctx.brandKit,
  }
  const report: VerificationReport = await verifyClaims(
    text,
    verifyCtx,
    ctx.verifiers ? { verifiers: ctx.verifiers } : {},
  )
  return jsonResult(report)
}

/** Verify a single (claim, ref) pair without requiring a tag wrapper. */
export async function toolVerifyClaim(
  args: { claim: string; ref: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const escapedRef = args.ref.replace(/"/g, '&quot;')
  const synthetic = `<claim ref="${escapedRef}">${args.claim}</claim>`
  const verifyCtx: VerifierContext = {
    workspaceRoot: ctx.workspaceRoot,
    brandKit: ctx.brandKit,
  }
  const report = await verifyClaims(
    synthetic,
    verifyCtx,
    ctx.verifiers ? { verifiers: ctx.verifiers } : {},
  )
  const first = report.claims[0] ?? null
  return jsonResult(first)
}

/** Describe the supplied Verifier set as a summary. */
export function toolListVerifiers(verifiers: Verifier[]): ToolResult {
  const list = verifiers.map((v) => ({
    prefix: v.prefix,
    name: v.name,
    description: v.description ?? null,
    discovery: typeof v.discover === 'function',
  }))
  return jsonResult({ verifiers: list })
}

/** Union the discover() output of every Verifier that supports it. */
export async function toolDiscoverRefs(
  verifiers: Verifier[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const menu: DiscoveryMenu = await buildDiscoveryMenu(verifiers, {
    workspaceRoot: ctx.workspaceRoot,
    brandKit: ctx.brandKit,
  })
  return jsonResult(menu)
}
