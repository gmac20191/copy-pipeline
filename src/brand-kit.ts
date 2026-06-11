/**
 * Brand-kit loader + Zod schema.
 *
 * The brand-kit is a per-project JSON file at `docs/brand/brand-kit.json`
 * declaring canonical specs, deterministic rules, corpora, exemplars, model
 * defaults, and (V2) destinations. Both brand-review and copy-pipeline
 * converge on consuming it.
 *
 * Architecture rationale lives in the consuming project's ADR
 * (`docs/decisions/<date>-copy-pipeline-architecture.md`).
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { z } from 'zod'

// ─── Schema ─────────────────────────────────────────────────────────────────

const canonicalSchema = z.object({
  spec: z.string(),
  rules: z.string().optional(),
  description: z.string().optional(),
})

const corpusSchema = z.object({
  backend: z.string(), // e.g. "pgvector"
  index_name: z.string(),
  description: z.string().optional(),
  source_glob: z.string().optional(),
  status: z.enum(['active', 'deferred', 'indexing']).default('active'),
})

const exemplarRefSchema = z.object({
  kind: z.string(), // "post-slug" | "component" | …
  path: z.string(),
  slug: z.string().optional(),
  note: z.string().optional(),
})

const modelsSchema = z.object({
  description: z.string().optional(),
  candidates: z.array(z.string()).min(1),
  grader: z.string(),
  embedder: z.string().optional(),
  rotation_rule: z.string().optional(),
})

const destinationEntrySchema = z.object({
  /** Adapter name — must match a registered DestinationAdapter (e.g. "output-file",
   *  "git-commit-pr", "atlassian-mcp", "slack-mcp"). */
  adapter: z.string().min(1),
  /** Adapter-specific config. Each adapter validates its own config shape
   *  inside `publish()` so brand-kit stays adapter-agnostic. */
  config: z.record(z.unknown()).default({}),
  /** Optional human description shown in ship listings. */
  description: z.string().optional(),
})

const inputSourceEntrySchema = z.object({
  /** Adapter name — must match a registered BriefSource (e.g. "google-drive"). */
  adapter: z.string().min(1),
  /** Adapter-specific config. Each Source validates its own config shape
   *  inside `watch()` so brand-kit stays adapter-agnostic. */
  config: z.record(z.unknown()).default({}),
  /** Destination key (from `destinations.entries`) where each generated
   *  variant for events from this source should be published. The default
   *  daemon policy is "every variant goes to /reviewed for human pick". */
  reviewed_destination: z.string().min(1),
  /** Optional destination key where the daemon publishes a marker /
   *  error report if generation fails for an event from this source. */
  needs_attention_destination: z.string().min(1).optional(),
  /** Optional human description. */
  description: z.string().optional(),
})

const verifiersSchema = z.object({
  description: z.string().optional(),
  /**
   * Module specifiers to import + register at startup. Each module's
   * exports are scanned for objects matching the Verifier interface
   * (prefix + verify + name); each one found is registered via
   * registerVerifier(). Specifiers should be npm package names
   * ("@acme/copy-pipeline-plugins") or absolute paths
   * ("/abs/path/to/verifiers.ts"). Relative paths resolve against the
   * process CWD at run time, which is typically the consumer's repo
   * root but is not guaranteed — use npm names or absolute paths to be
   * unambiguous.
   */
  plugins: z.array(z.string()).default([]),
  /**
   * Opt-in toggles for built-in verifiers that aren't loaded by default
   * because they have external dependencies (browser, network, auth).
   */
  builtins: z
    .object({
      notebooklm: z.boolean().default(false),
      notebooklm_notebook_id: z.string().optional(),
      /** Optional LLM-as-judge model id (e.g. "anthropic/claude-opus-4-7").
       *  When set, the NotebookLM verifier interprets the corpus response
       *  against each claim instead of treating citations-presence as
       *  sufficient evidence. */
      notebooklm_judge: z.string().optional(),
    })
    .partial()
    .optional(),
})

export const brandKitSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  canonicals: z.record(canonicalSchema),
  corpora: z.record(corpusSchema).default({}),
  exemplars: z
    .object({
      description: z.string().optional(),
    })
    .catchall(z.array(exemplarRefSchema))
    .optional(),
  models: modelsSchema,
  destinations: z
    .object({
      description: z.string().optional(),
      entries: z.record(destinationEntrySchema).default({}),
    })
    .optional(),
  input_sources: z
    .object({
      description: z.string().optional(),
      entries: z.record(inputSourceEntrySchema).default({}),
    })
    .optional(),
  /** Optional Langfuse-specific config. The daemon reads this to wire
   *  itself into the project's Langfuse setup (annotation queue routing,
   *  custom score configs, …). Auth still comes from LANGFUSE_* env vars
   *  — the brand-kit only carries non-secret IDs. */
  langfuse: z
    .object({
      /** Annotation queue ID to auto-route every published trace into.
       *  Create the queue via `POST /api/public/annotation-queues`
       *  (or once in the Langfuse UI), then paste the id here. When
       *  unset, the daemon doesn't route — the operator would have to triage
       *  traces into a queue by hand in the Langfuse UI. */
      annotation_queue_id: z.string().optional(),
    })
    .optional(),
  verifiers: verifiersSchema.optional(),
  language: z
    .object({
      spelling: z.string().optional(),
      exceptions: z.array(z.string()).optional(),
      description: z.string().optional(),
    })
    .optional(),
})

export type BrandKit = z.infer<typeof brandKitSchema>

// ─── Discovery + loading ─────────────────────────────────────────────────────

/**
 * Walk up from $CLAUDE_PROJECT_DIR (if set) then CWD looking for
 * `docs/brand/brand-kit.json`. Returns the first hit, or null.
 *
 * Mirror of brand-review skill's `resolve_rules_file()` so both consumers
 * resolve to the same brand-kit per the don't-duplicate principle.
 */
export function findBrandKitPath(startDir?: string): string | null {
  const candidates: string[] = []

  const projectDir = process.env['CLAUDE_PROJECT_DIR']
  if (projectDir) {
    candidates.push(join(projectDir, 'docs', 'brand', 'brand-kit.json'))
  }

  let cur = resolve(startDir ?? process.cwd())
  while (true) {
    candidates.push(join(cur, 'docs', 'brand', 'brand-kit.json'))
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Load + validate the brand-kit. Throws if not found or invalid.
 *
 * Pass `path` to override discovery (useful for tests, multi-tenant invocations
 * inside a service, or explicit per-call brand-kit selection).
 */
export async function loadBrandKit(path?: string): Promise<BrandKit> {
  const resolved = path ?? findBrandKitPath()
  if (!resolved) {
    throw new Error(
      'brand-kit not found: looked for docs/brand/brand-kit.json walking up from $CLAUDE_PROJECT_DIR / CWD',
    )
  }
  const raw = await readFile(resolved, 'utf-8')
  const parsed = JSON.parse(raw)
  const result = brandKitSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `brand-kit at ${resolved} failed validation: ${result.error.message}`,
    )
  }
  return result.data
}

/**
 * Expand `~` in a path to the user's home dir. Used for rules paths declared
 * in brand-kit (e.g. "~/.claude/skills/brand-review/rules.json").
 */
export function expandUser(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(2))
  }
  return p
}
