#!/usr/bin/env node
/**
 * copy-pipeline CLI shell.
 *
 * Three subcommands per ADR:
 *   - `gen`   — generate variants for a brief
 *   - `index` — (re-)index a named corpus's source materials
 *   - `pick`  — record an operator pick + edits for a prior run
 *
 * All three are stubs in v0.1.0-alpha.0. The library logic lives in `src/`;
 * this shell does argument parsing + calls into the library.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join as joinPath, resolve as resolvePath } from 'node:path'

import { Command } from 'commander'
import { loadBrandKit } from '../src/brand-kit.js'
import { generate } from '../src/generate.js'
import { resolveEmbedder } from '../src/grounding/embed.js'
import { defaultGroundingSources } from '../src/grounding/index.js'
import { ingestMarkdown } from '../src/grounding/ingest.js'
import { dropPgvectorTable } from '../src/grounding/pgvector.js'
import {
  PRESET_NAMES,
  type IngestPreset,
} from '../src/grounding/presets/index.js'
import { ship } from '../src/ship.js'
import { recordPick } from '../src/pick.js'
import {
  defaultVerifiers,
  registerVerifier,
  VERIFIER_REGISTRY,
  type Verifier,
} from '../src/verifier/index.js'
import {
  notebookLMVerifier,
  createNotebookLMVerifier,
  createDefaultJudge,
} from '../src/verifier/notebooklm.js'
import {
  verifyClaims,
  type VerificationReport,
} from '../src/verifier/dispatcher.js'

const program = new Command()

program
  .name('copy-pipeline')
  .description('Brief → multi-model variants → graded → operator pick')
  .version('0.1.0-alpha.6')

// ─── gen ────────────────────────────────────────────────────────────────────

program
  .command('gen')
  .description('Generate N graded variants for a brief')
  .requiredOption('-b, --brief <text>', 'Operator brief (1-3 sentences)')
  .option(
    '-g, --ground <corpora>',
    'Comma-separated corpus handles to ground against (e.g. voice,science)',
    '',
  )
  .option(
    '--brand-kit <path>',
    'Override brand-kit auto-discovery with an explicit path',
  )
  .option('--json', 'Emit machine-readable JSON instead of human-readable text')
  .action(async (opts) => {
    const brandKit = await loadBrandKit(opts.brandKit)
    const ground = opts.ground
      ? String(opts.ground)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []

    const run = await generate({
      brief: {
        text: String(opts.brief),
        ground,
      },
      brandKit,
    })

    if (opts.json) {
      console.log(JSON.stringify(run, null, 2))
      return
    }

    console.log(
      `run ${run.runId}\nbrand-kit: ${brandKit.name} v${brandKit.version}`,
    )
    console.log(`\n${run.graded.length} variant(s):\n`)
    for (const [i, g] of run.graded.entries()) {
      console.log(`── variant ${i} (${g.variant.model}) ─────────────`)
      console.log(g.variant.text)
      console.log(`score: ${g.score}  findings: ${g.findings.length}`)
      console.log()
    }
  })

// ─── index ──────────────────────────────────────────────────────────────────

async function runIndex(
  corpus: string,
  opts: {
    from?: string
    brandKit?: string
    preset?: string
  },
): Promise<void> {
  const brandKit = await loadBrandKit(opts.brandKit)
  const corpusEntry = brandKit.corpora[corpus]
  if (!corpusEntry) {
    console.error(`unknown corpus: ${corpus}`)
    console.error(
      `available: ${Object.keys(brandKit.corpora).join(', ') || '(none declared)'}`,
    )
    process.exitCode = 2
    return
  }

  const source = opts.from ?? corpusEntry.source_glob
  if (!source) {
    console.error(
      `no source provided: pass --from <path>, or declare source_glob on the corpus in brand-kit`,
    )
    process.exitCode = 2
    return
  }

  const preset: IngestPreset = (opts.preset ?? 'vanilla') as IngestPreset
  if (!PRESET_NAMES.includes(preset)) {
    console.error(
      `unknown preset "${opts.preset}". Supported: ${PRESET_NAMES.join(', ')}.`,
    )
    process.exitCode = 2
    return
  }

  const sources = await defaultGroundingSources()
  const backend = sources.find((s) => s.backend === corpusEntry.backend)
  if (!backend) {
    console.error(
      `no GroundingSource registered for backend "${corpusEntry.backend}"`,
    )
    process.exitCode = 2
    return
  }

  const embedder = resolveEmbedder(brandKit.models.embedder)

  console.log(
    `ingesting '${corpus}' (backend=${corpusEntry.backend}, index_name=${corpusEntry.index_name})`,
  )
  console.log(`  source:    ${source}`)
  console.log(`  preset:    ${preset}`)
  console.log(`  embedder:  ${embedder.id} (${embedder.dimension}d)`)

  const startedAt = Date.now()
  const result = await ingestMarkdown({ source: String(source), preset })
  const parsedMs = Date.now() - startedAt

  if (result.chunks.length === 0) {
    console.log(`no chunks produced — no .md files matched.`)
    return
  }

  console.log(
    `  chunked:   ${result.chunks.length} chunks from ${result.fileCount} files ` +
      `(${(result.bytesRead / 1024).toFixed(1)} KiB, ${parsedMs}ms)`,
  )

  const writeStart = Date.now()
  await backend.write({
    corpusHandle: corpus,
    indexName: corpusEntry.index_name,
    chunks: result.chunks,
    embedder,
  })
  const writeMs = Date.now() - writeStart

  console.log(`✓ wrote ${result.chunks.length} chunks in ${writeMs}ms`)
}

program
  .command('index')
  .description("(Re-)index a named corpus's source materials into its backend")
  .argument('<corpus>', 'Corpus handle declared in brand-kit (e.g. voice)')
  .option(
    '-f, --from <glob>',
    "Source materials path or glob (overrides brand-kit's source_glob)",
  )
  .option(
    '--preset <name>',
    `Source-format preset: ${PRESET_NAMES.join(' | ')}`,
    'vanilla',
  )
  .option('--brand-kit <path>', 'Override brand-kit auto-discovery')
  .action(runIndex)

// ─── reindex ────────────────────────────────────────────────────────────────

program
  .command('reindex')
  .description(
    'Drop a corpus and re-ingest from scratch. Required when the brand-kit ' +
      'embedder changes dimension.',
  )
  .argument('<corpus>', 'Corpus handle declared in brand-kit')
  .option(
    '-f, --from <glob>',
    "Source materials path or glob (overrides brand-kit's source_glob)",
  )
  .option(
    '--preset <name>',
    `Source-format preset: ${PRESET_NAMES.join(' | ')}`,
    'vanilla',
  )
  .option('--brand-kit <path>', 'Override brand-kit auto-discovery')
  .action(async (corpus: string, opts) => {
    const brandKit = await loadBrandKit(opts.brandKit)
    const corpusEntry = brandKit.corpora[corpus]
    if (!corpusEntry) {
      console.error(`unknown corpus: ${corpus}`)
      process.exitCode = 2
      return
    }

    if (corpusEntry.backend !== 'pgvector') {
      console.error(
        `reindex only supports the pgvector backend; corpus "${corpus}" uses "${corpusEntry.backend}"`,
      )
      process.exitCode = 2
      return
    }

    console.log(
      `dropping table for corpus "${corpus}" (index_name=${corpusEntry.index_name})…`,
    )
    await dropPgvectorTable(corpusEntry.index_name)
    console.log(`✓ dropped`)
    console.log()

    await runIndex(corpus, opts)
  })

// ─── pick ───────────────────────────────────────────────────────────────────

program
  .command('pick')
  .description(
    'Record an operator pick + edits for a prior generation run. Emits ' +
      'an operator_pick score on the original Langfuse trace, with the ' +
      'edited copy (first 1000 chars) attached as the score comment.',
  )
  .argument('<run-id>', 'The runId from a previous `gen` invocation')
  .requiredOption('-v, --variant <id>', 'The variantId being picked')
  .option(
    '-e, --edits <path>',
    'Path to a file containing post-pick edits (the final shipped copy)',
  )
  .action(async (runId: string, opts) => {
    let edits: string | undefined
    if (opts.edits) {
      edits = await readFile(opts.edits, 'utf-8')
    }

    const result = await recordPick({
      runId,
      variantId: opts.variant,
      ...(edits !== undefined ? { edits } : {}),
    })

    if (result.ok) {
      console.log(
        `✓ recorded pick: run=${runId} variant=${opts.variant}` +
          (edits ? ` edits=${edits.length} chars` : ''),
      )
    } else {
      console.error(`✗ pick failed: ${result.reason}`)
      process.exitCode = 1
    }
  })

// ─── ship ───────────────────────────────────────────────────────────────────

program
  .command('ship')
  .description(
    'Publish picked copy to a destination declared in brand-kit.destinations.entries',
  )
  .requiredOption(
    '-d, --destination <name>',
    'Destination key from brand-kit.destinations.entries',
  )
  .option(
    '-c, --copy-from <path>',
    'Path to a file containing the copy to ship',
  )
  .option(
    '-p, --paste',
    'Read the copy to ship from stdin (alternative to --copy-from)',
  )
  .option('--brand-kit <path>', 'Override brand-kit auto-discovery')
  .option('--json', 'Emit machine-readable JSON result')
  .action(async (opts) => {
    const brandKit = await loadBrandKit(opts.brandKit)

    let copy: string
    if (opts.copyFrom) {
      copy = await readFile(opts.copyFrom, 'utf-8')
    } else if (opts.paste) {
      copy = await readStdin()
    } else {
      console.error(
        'ship: provide --copy-from <path> or --paste (read from stdin)',
      )
      process.exitCode = 2
      return
    }

    const result = await ship({
      copy,
      destination: opts.destination,
      brandKit,
    })

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      if (result.ok) {
        console.log(
          `✓ shipped to "${result.destinationName}" via ${result.adapterName}` +
            (result.detail ? ` (${result.detail})` : '') +
            (result.url ? `\n  → ${result.url}` : ''),
        )
      } else {
        console.log(
          `✗ ship failed: "${result.destinationName}" via ${result.adapterName}`,
        )
        if (result.error) console.log(`  ${result.error}`)
      }
    }

    if (!result.ok) {
      process.exitCode = 1
    }
  })

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** Try to load a brand-kit; fall back to a minimal stub if none found. */
async function tryLoadBrandKit(): Promise<
  Awaited<ReturnType<typeof loadBrandKit>>
> {
  try {
    return await loadBrandKit()
  } catch {
    return {
      name: 'ad-hoc',
      version: '0.0.0',
      canonicals: {},
      corpora: {},
      models: { candidates: ['stub/stub'], grader: 'stub/stub' },
    } as Awaited<ReturnType<typeof loadBrandKit>>
  }
}

// ─── verify ─────────────────────────────────────────────────────────────────

interface VerifyCliOptions {
  workspace?: string
  brandKit?: string
  withNotebooklm?: boolean
  notebookId?: string
  judge?: string
  plugin?: string[]
  json?: boolean
  traceDir?: string
}

async function loadPluginModule(spec: string): Promise<unknown> {
  // Resolve relative paths against cwd so users can `--plugin ./my-plugin.ts`.
  const isLocal =
    spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')
  const target = isLocal ? resolvePath(process.cwd(), spec) : spec
  return import(target)
}

async function registerPluginVerifiers(specs: string[]): Promise<void> {
  for (const spec of specs) {
    const mod = (await loadPluginModule(spec)) as Record<string, unknown>
    let registered = 0
    for (const value of Object.values(mod)) {
      if (
        value &&
        typeof value === 'object' &&
        'prefix' in value &&
        'verify' in value &&
        typeof (value as Verifier).verify === 'function'
      ) {
        registerVerifier(value as Verifier)
        registered++
      }
    }
    console.error(`loaded ${registered} verifier(s) from '${spec}'`)
  }
}

function renderReport(report: VerificationReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`claims: ${report.counts.total}`)
  console.log(`  verified:        ${report.counts.verified}`)
  console.log(`  unverified:      ${report.counts.unverified}`)
  console.log(`  error:           ${report.counts.error}`)
  console.log(`  needs-evidence:  ${report.counts.needsEvidence}`)
  console.log()

  for (const [idx, c] of report.claims.entries()) {
    const preview = c.text.length > 80 ? `${c.text.slice(0, 80)}…` : c.text
    console.log(`[${idx + 1}] ${c.rawRef}`)
    console.log(`    text:    ${preview}`)
    console.log(`    verdict: ${c.verdict.verdict}`)
    if (c.verdict.verdict === 'verified') {
      if (c.verdict.supporting) {
        const sup =
          c.verdict.supporting.length > 200
            ? `${c.verdict.supporting.slice(0, 200)}…`
            : c.verdict.supporting
        console.log(`    support: ${sup}`)
      }
      console.log(`    source:  ${c.verdict.source.uri}`)
    } else if (c.verdict.verdict === 'unverified') {
      console.log(`    reason:  ${c.verdict.reason}`)
      if (c.verdict.hint) console.log(`    hint:    ${c.verdict.hint}`)
    } else if (c.verdict.verdict === 'error') {
      console.log(`    message: ${c.verdict.message}`)
    }
    console.log()
  }
}

function verifyExitCode(report: VerificationReport): number {
  if (report.counts.unverified > 0) return 1
  if (report.counts.error > 0) return 2
  return 0
}

program
  .command('verify')
  .description(
    'Verify the <claim ref="..."> tags in a markdown file against registered Verifiers. ' +
      'Exit 0 if all verified or needs-evidence only; 1 on any unverified; 2 on any error.',
  )
  .argument('<file>', 'Path to the tagged markdown file to verify')
  .option(
    '-w, --workspace <path>',
    'Workspace root passed to Verifiers as VerifierContext.workspaceRoot',
    process.cwd(),
  )
  .option('--brand-kit <path>', 'Override brand-kit auto-discovery')
  .option(
    '--with-notebooklm',
    'Register the NotebookLM verifier (off by default; requires the notebooklm-query skill)',
  )
  .option(
    '--notebook-id <id>',
    'NotebookLM notebook id; sets NOTEBOOKLM_NOTEBOOK_ID for empty ref bodies',
  )
  .option(
    '--judge <provider/model>',
    'LLM-as-judge model id (e.g. "anthropic/claude-opus-4-7"). When set, the NotebookLM verifier interprets the corpus response against each claim instead of treating citations-presence as sufficient.',
  )
  .option(
    '--plugin <spec>',
    'Module path/specifier exporting one or more Verifier objects. Repeatable.',
    (val: string, prior: string[] = []) => [...prior, val],
  )
  .option('--json', 'Emit JSON instead of human-readable text')
  .option(
    '--trace-dir <path>',
    "Write one auditable trace JSON per claim into this directory, keyed by the claim's `id` attribute (or a SHA-256 of the ref+text if no `id`). Each file contains the full verifier-emitted trace plus a claimHash for downstream staleness detection.",
  )
  .action(async (file: string, opts: VerifyCliOptions) => {
    // brand-kit is optional for verify — the shipped verifiers don't read it,
    // and consumers without a brand-kit (e.g. running verification on an
    // ad-hoc markdown file) shouldn't be forced to author one.
    const brandKit = opts.brandKit
      ? await loadBrandKit(opts.brandKit)
      : await tryLoadBrandKit()

    // Default verifiers (file). Opt-in for notebookLM since it has external deps.
    for (const v of await defaultVerifiers()) {
      if (!VERIFIER_REGISTRY.has(v.prefix)) registerVerifier(v)
    }

    // Brand-kit-driven opt-ins (declarative, no flag needed).
    const verifiersCfg = brandKit.verifiers
    const enableNotebookLM =
      opts.withNotebooklm === true ||
      verifiersCfg?.builtins?.notebooklm === true
    const notebookId =
      opts.notebookId ?? verifiersCfg?.builtins?.notebooklm_notebook_id
    const judgeModelId = opts.judge ?? verifiersCfg?.builtins?.notebooklm_judge

    if (enableNotebookLM) {
      const cfg: Parameters<typeof createNotebookLMVerifier>[0] = {}
      if (notebookId) cfg.defaultNotebookId = notebookId
      if (judgeModelId) cfg.judge = createDefaultJudge(judgeModelId)
      const v =
        notebookId || judgeModelId
          ? createNotebookLMVerifier(cfg)
          : notebookLMVerifier
      registerVerifier(v)
    } else if (opts.notebookId) {
      console.error(
        'warning: --notebook-id ignored without --with-notebooklm (or brand-kit verifiers.builtins.notebooklm: true)',
      )
    } else if (opts.judge) {
      console.error(
        'warning: --judge ignored without --with-notebooklm (or brand-kit verifiers.builtins.notebooklm: true)',
      )
    }

    // Plugins from brand-kit + CLI. Brand-kit plugins first so explicit
    // --plugin can fail-fast on prefix collisions if the user is trying
    // to override.
    const brandKitPlugins = verifiersCfg?.plugins ?? []
    const cliPlugins = opts.plugin ?? []
    if (brandKitPlugins.length > 0) {
      await registerPluginVerifiers(brandKitPlugins)
    }
    if (cliPlugins.length > 0) {
      await registerPluginVerifiers(cliPlugins)
    }

    const text = await readFile(file, 'utf-8')
    const workspaceRoot = resolvePath(opts.workspace ?? process.cwd())

    const report = await verifyClaims(text, { workspaceRoot, brandKit })

    if (opts.traceDir) {
      await writeTraceFiles(report, resolvePath(opts.traceDir), file)
    }

    renderReport(report, Boolean(opts.json))

    const code = verifyExitCode(report)
    if (code !== 0) process.exitCode = code
  })

/**
 * Persist one trace JSON per claim into `traceDir`. The filename uses the
 * claim's `id` attribute when present (so consumer apps can reference
 * `<traceDir>/<id>.json` deterministically); otherwise it falls back to a
 * SHA-256 hash of `<rawRef>:<text>`. `claimHash` records the SHA-256 of
 * the claim prose so the gate can detect prose drift after the last verify.
 */
async function writeTraceFiles(
  report: VerificationReport,
  traceDir: string,
  sourceFile: string,
): Promise<void> {
  await mkdir(traceDir, { recursive: true })
  for (const claim of report.claims) {
    const id =
      claim.attrs?.['id'] ??
      createHash('sha256')
        .update(`${claim.rawRef}\n${claim.text}`)
        .digest('hex')
        .slice(0, 16)
    const claimHash = createHash('sha256').update(claim.text).digest('hex')
    const fileEntry = {
      id,
      rawRef: claim.rawRef,
      sourceFile,
      claimText: claim.text,
      claimHash,
      attrs: claim.attrs,
      verdict: claim.verdict,
      generatedAt: new Date().toISOString(),
    }
    await writeFile(
      joinPath(traceDir, `${id}.json`),
      JSON.stringify(fileEntry, null, 2) + '\n',
      'utf-8',
    )
  }
}

// ─── propose ────────────────────────────────────────────────────────────────

program
  .command('propose')
  .description(
    'Analyse Langfuse-captured signal (picks, scores, annotations) from the past N days and propose evidence-backed changes to the brand-kit (rules, canonical, candidates). Writes a markdown report to the configured destination.',
  )
  .option('--brand-kit <path>', 'Path to brand-kit.json (default: discover)')
  .option('-d, --days <n>', 'Look-back window in days', '7')
  .option(
    '--destination <name>',
    'Destination key in brand-kit.destinations.entries to write the proposals to',
  )
  .option('--max-traces <n>', 'Cap traces fetched from Langfuse', String(100))
  .option(
    '--snippet-chars <n>',
    'Cap per-variant output snippet length',
    String(800),
  )
  .option(
    '--analyzer-model <id>',
    'Model id for the analysis call (default google-vertex/gemini-2.5-pro)',
  )
  .option(
    '--dry-run',
    'Print the markdown to stdout instead of publishing to the destination',
  )
  .action(
    async (opts: {
      brandKit?: string
      days: string
      destination?: string
      maxTraces: string
      snippetChars: string
      analyzerModel?: string
      dryRun?: boolean
    }) => {
      const { runProposer, publishProposals } =
        await import('../src/proposer.js')
      const brandKit = await loadBrandKit(opts.brandKit)
      const workspaceRoot = process.cwd()

      // rules + canonical paths: resolve from brand-kit.canonicals.marketing
      const canonicalEntry = brandKit.canonicals['marketing']
      if (!canonicalEntry) {
        throw new Error(
          'brand-kit has no canonicals.marketing entry — proposer needs CANONICAL.md + rules.json paths',
        )
      }
      const canonicalPath = resolvePath(workspaceRoot, canonicalEntry.spec)
      const rulesPath = canonicalEntry.rules
        ? resolvePath(workspaceRoot, canonicalEntry.rules)
        : ''

      const proposerOptions: Parameters<typeof runProposer>[0] = {
        brandKit,
        rulesPath,
        canonicalPath,
        windowDays: Number(opts.days),
        maxTraces: Number(opts.maxTraces),
        snippetChars: Number(opts.snippetChars),
      }
      if (opts.analyzerModel) proposerOptions.analyzerModel = opts.analyzerModel
      const result = await runProposer(proposerOptions)

      if (opts.dryRun || !opts.destination) {
        process.stdout.write(result.markdown + '\n')
        return
      }

      const destEntry = brandKit.destinations?.entries?.[opts.destination]
      if (!destEntry) {
        throw new Error(
          `--destination "${opts.destination}" not found in brand-kit.destinations.entries`,
        )
      }
      const { defaultDestinations } =
        await import('../src/destination/index.js')
      const adapters = await defaultDestinations()
      const adapter = adapters.find((a) => a.name === destEntry.adapter)
      if (!adapter) {
        throw new Error(
          `destination "${opts.destination}" references unregistered adapter "${destEntry.adapter}"`,
        )
      }

      const ship = await publishProposals({
        destinationAdapter: adapter,
        destinationName: opts.destination,
        destinationConfig: destEntry.config,
        result,
      })
      if (!ship.ok) {
        process.stderr.write(`publish failed: ${ship.error}\n`)
        process.exitCode = 1
        return
      }
      process.stdout.write(
        `proposed ${result.markdown.length} chars to "${opts.destination}"${
          ship.url ? ` → ${ship.url}` : ''
        }\n`,
      )
    },
  )

await program.parseAsync(process.argv)
