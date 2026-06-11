#!/usr/bin/env node
/**
 * copy-pipeline MCP server.
 *
 * Wraps the core registries (Verifier, ClaimExtractor, Grader,
 * GroundingSource, Destination) as MCP tools so Claude Code / Cursor /
 * Claude Desktop / any MCP-speaking client can invoke them inline.
 *
 * Transport: stdio (the default for local CLI-spawned MCP servers).
 *
 * Tool surface (fine-grained; agents compose pipelines themselves):
 *   - cp_verify_claims     — parse <claim> tags from a markdown string,
 *                            dispatch to registered Verifiers, return
 *                            per-claim verdicts + aggregate counts.
 *   - cp_verify_claim      — verify one (claim, ref) pair directly,
 *                            bypassing the tag parser.
 *   - cp_list_verifiers    — describe the currently registered Verifier
 *                            set (prefix, name, description).
 *   - cp_discover_refs     — call discover() on each Verifier with
 *                            discovery support; return the union of
 *                            DiscoveredRef entries for use as a menu.
 *
 * Configuration is read from a brand-kit when one exists in the
 * spawned-cwd (or override via $COPY_PIPELINE_BRAND_KIT). Plugin
 * specifiers in brand-kit.verifiers.plugins are imported and registered
 * on first tool call (lazy — avoids slow startup when no tool is used).
 *
 * Per ADR 0002's deferred-adapter list, the MCP server is now wired.
 * Coarse-grained tools (cp_generate_and_verify) can land later if the
 * fine-grained set proves too low-level for common LLM workflows.
 */

import { resolve as resolvePath } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { loadBrandKit, type BrandKit } from '../src/brand-kit.js'
import {
  defaultVerifiers,
  registerVerifier,
  VERIFIER_REGISTRY,
  type Verifier,
} from '../src/verifier/index.js'
import {
  notebookLMVerifier,
  createNotebookLMVerifier,
} from '../src/verifier/notebooklm.js'
import {
  toolVerifyClaims,
  toolVerifyClaim,
  toolListVerifiers,
  toolDiscoverRefs,
  type ToolContext,
} from '../src/mcp-tools.js'

// ─── Lazy initialisation ────────────────────────────────────────────────────

let initialised = false
let cachedBrandKit: BrandKit | null = null

/**
 * Best-effort brand-kit load; returns a stub when none discovered so the
 * server can still serve ad-hoc verification calls.
 */
async function getBrandKit(): Promise<BrandKit> {
  if (cachedBrandKit) return cachedBrandKit
  const override = process.env['COPY_PIPELINE_BRAND_KIT']
  try {
    cachedBrandKit = await loadBrandKit(override)
  } catch {
    cachedBrandKit = {
      name: 'ad-hoc',
      version: '0.0.0',
      canonicals: {},
      corpora: {},
      models: { candidates: ['stub/stub'], grader: 'stub/stub' },
    } as BrandKit
  }
  return cachedBrandKit
}

async function loadPluginModule(spec: string): Promise<unknown> {
  const isLocal =
    spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')
  const target = isLocal ? resolvePath(process.cwd(), spec) : spec
  return import(target)
}

async function ensureRegistries(): Promise<void> {
  if (initialised) return
  initialised = true

  // Built-in verifiers
  for (const v of await defaultVerifiers()) {
    if (!VERIFIER_REGISTRY.has(v.prefix)) registerVerifier(v)
  }

  const brandKit = await getBrandKit()
  const verifiersCfg = brandKit.verifiers

  if (verifiersCfg?.builtins?.notebooklm === true) {
    const notebookId = verifiersCfg.builtins.notebooklm_notebook_id
    const v = notebookId
      ? createNotebookLMVerifier({ defaultNotebookId: notebookId })
      : notebookLMVerifier
    if (!VERIFIER_REGISTRY.has(v.prefix)) registerVerifier(v)
  }

  for (const spec of verifiersCfg?.plugins ?? []) {
    try {
      const mod = (await loadPluginModule(spec)) as Record<string, unknown>
      for (const value of Object.values(mod)) {
        if (
          value &&
          typeof value === 'object' &&
          'prefix' in value &&
          'verify' in value &&
          typeof (value as Verifier).verify === 'function'
        ) {
          if (!VERIFIER_REGISTRY.has((value as Verifier).prefix)) {
            registerVerifier(value as Verifier)
          }
        }
      }
    } catch (err) {
      // Don't crash the server on a bad plugin; surface via stderr.
      console.error(
        `copy-pipeline-mcp: failed to load plugin '${spec}': ${(err as Error).message}`,
      )
    }
  }
}

// ─── Tool wiring ──────────────────────────────────────────────────────────

function workspaceRoot(): string {
  return process.env['COPY_PIPELINE_WORKSPACE'] ?? process.cwd()
}

async function buildCtx(): Promise<ToolContext> {
  await ensureRegistries()
  return {
    workspaceRoot: workspaceRoot(),
    brandKit: await getBrandKit(),
  }
}

function registeredVerifiers(): Verifier[] {
  return [...VERIFIER_REGISTRY.values()]
}

// ─── MCP tool descriptors ───────────────────────────────────────────────────

const VerifyClaimsArgs = z.object({
  text: z
    .string()
    .describe(
      'A markdown string containing zero or more <claim ref="prefix:body">text</claim> tags.',
    ),
})

const VerifyClaimArgs = z.object({
  claim: z.string().describe('The prose being verified.'),
  ref: z
    .string()
    .describe(
      'Evidence ref in "prefix:body" form. Prefix routes to a Verifier.',
    ),
})

const NoArgs = z.object({})

const TOOLS = [
  {
    name: 'cp_verify_claims',
    description:
      'Parse <claim ref="prefix:body">text</claim> tags from a markdown string, dispatch each to the registered Verifier set, return per-claim verdicts and aggregate counts. Use to gate a piece of content at publish.',
    inputSchema: VerifyClaimsArgs,
  },
  {
    name: 'cp_verify_claim',
    description:
      "Verify a single claim against an evidence ref directly. Use when you have one assertion and one ref and don't want to wrap-tag a markdown string.",
    inputSchema: VerifyClaimArgs,
  },
  {
    name: 'cp_list_verifiers',
    description:
      'Describe the currently registered Verifier set (prefix, name, description, whether it implements discover()). Use to find out which evidence ref prefixes are available before tagging.',
    inputSchema: NoArgs,
  },
  {
    name: 'cp_discover_refs',
    description:
      "Call discover() on each Verifier that implements it and return the union of DiscoveredRef entries. Use to compose a proposal menu for an LLM-driven claim-extraction pass — or to enumerate what's available in the current workspace.",
    inputSchema: NoArgs,
  },
] as const

// ─── Server boot ────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'copy-pipeline', version: '0.1.0-alpha.7' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const argsObject = (args ?? {}) as Record<string, unknown>

  switch (name) {
    case 'cp_verify_claims': {
      const parsed = VerifyClaimsArgs.parse(argsObject)
      return (await toolVerifyClaims(
        parsed.text,
        await buildCtx(),
      )) as CallToolResult
    }
    case 'cp_verify_claim': {
      const parsed = VerifyClaimArgs.parse(argsObject)
      return (await toolVerifyClaim(parsed, await buildCtx())) as CallToolResult
    }
    case 'cp_list_verifiers': {
      await ensureRegistries()
      return toolListVerifiers(registeredVerifiers()) as CallToolResult
    }
    case 'cp_discover_refs': {
      return (await toolDiscoverRefs(
        registeredVerifiers(),
        await buildCtx(),
      )) as CallToolResult
    }
    default: {
      throw new Error(`Unknown tool: ${name}`)
    }
  }
})

/** Minimal Zod → JSON Schema for the MCP tool input contract. The MCP SDK
 * expects a plain JSON Schema, not a Zod object — so we lower the schemas
 * we declared above. Kept inline rather than pulling zod-to-json-schema
 * for the four tools we currently expose. */
function zodToJsonSchema(schema: z.ZodTypeAny): {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
} {
  const shape =
    schema instanceof z.ZodObject ? schema.shape : ({} as z.ZodRawShape)
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, value] of Object.entries(shape)) {
    const v = value as z.ZodTypeAny
    properties[key] = {
      type: 'string',
      description:
        (v as unknown as { _def?: { description?: string } })._def
          ?.description ?? '',
    }
    if (!(v instanceof z.ZodOptional)) required.push(key)
  }
  return { type: 'object', properties, required }
}

const transport = new StdioServerTransport()
await server.connect(transport)
