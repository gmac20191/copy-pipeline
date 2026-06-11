#!/usr/bin/env node
/**
 * copy-pipeline-watch CLI.
 *
 * The folder-watching daemon. Reads brand-kit, registers default BriefSources
 * + Destinations (plus any plugins listed under brand-kit.verifiers.plugins —
 * the same plugin mechanism so consumers register Source/Destination adapters
 * the same way they register Verifiers), then calls `watchAll()`.
 *
 * On SIGINT / SIGTERM the daemon flips an AbortSignal so every source's
 * watch loop closes at its next yield boundary. The process then exits 0.
 *
 * Usage:
 *
 *   copy-pipeline-watch
 *       # picks up brand-kit via standard discovery
 *
 *   copy-pipeline-watch --brand-kit ./docs/brand/brand-kit.json
 *       # explicit brand-kit path
 *
 *   copy-pipeline-watch --workspace /abs/path
 *       # override workspace root (defaults to CWD)
 */

import { resolve as resolvePath } from 'node:path'

import { Command } from 'commander'

import { loadBrandKit } from '../src/brand-kit.js'
import {
  DESTINATION_REGISTRY,
  defaultDestinations,
  registerDestination,
} from '../src/destination/index.js'
import {
  INPUT_SOURCE_REGISTRY,
  registerInputSource,
} from '../src/source/index.js'
import { googleDriveSource } from '../src/source/google-drive.js'
import { watchAll } from '../src/watch.js'

const program = new Command()

program
  .name('copy-pipeline-watch')
  .description(
    'Watch every BriefSource declared in brand-kit and publish every generated variant to its /reviewed destination.',
  )
  .version('0.1.0-alpha.7')
  .option(
    '-b, --brand-kit <path>',
    'Path to brand-kit.json (defaults to discovery from CWD)',
  )
  .option(
    '-w, --workspace <path>',
    'Workspace root passed to sources + generate (default: CWD)',
  )
  .action(async (opts: { brandKit?: string; workspace?: string }) => {
    const brandKit = await loadBrandKit(opts.brandKit)
    const workspaceRoot = resolvePath(opts.workspace ?? process.cwd())

    // Set CLAUDE_PROJECT_DIR so subprocess graders/skills (notably brand-review)
    // walk up from the right tree when resolving the brand-kit. Otherwise
    // brand-review falls back to its bundled rules silently — exactly the
    // silent-absence failure mode the watch daemon needs to avoid.
    if (!process.env['CLAUDE_PROJECT_DIR']) {
      process.env['CLAUDE_PROJECT_DIR'] = workspaceRoot
    }

    // Register default destination roster.
    if (DESTINATION_REGISTRY.size === 0) {
      for (const d of await defaultDestinations()) registerDestination(d)
    }
    // Register the google-drive source. (BriefSources have no default roster;
    // consumers opt in. For the watch daemon's "batteries included" experience
    // we register the one real adapter we ship.)
    if (!INPUT_SOURCE_REGISTRY.has('google-drive')) {
      registerInputSource(googleDriveSource)
    }

    const ac = new AbortController()
    const shutdown = (sig: string): void => {
      // eslint-disable-next-line no-console
      console.log(`[copy-pipeline-watch] ${sig} received — shutting down`)
      ac.abort()
    }
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))

    await watchAll({
      brandKit,
      workspaceRoot,
      signal: ac.signal,
    })
  })

await program.parseAsync(process.argv)
