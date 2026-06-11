/**
 * output-file destination adapter.
 *
 * Writes picked copy to a local file path. The simplest possible destination:
 * useful for review-before-commit workflows, scratch drafts, and as a
 * smoke-test of the destination layer when other adapters aren't yet wired.
 *
 * Brand-kit config shape:
 *   {
 *     "adapter": "output-file",
 *     "config": {
 *       "path": "./_drafts/output.md"
 *     }
 *   }
 *
 * The path is resolved relative to the current working directory.
 * Intermediate directories are created automatically. Existing files are
 * overwritten without warning — the operator is responsible for picking
 * a path they're OK to clobber.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

import type { DestinationAdapter, ShipResult, PublishArgs } from './index.js'

const configSchema = z.object({
  path: z.string().min(1, 'config.path must be a non-empty string'),
})

export const outputFileDestination: DestinationAdapter = {
  name: 'output-file',
  description:
    'Write the picked copy to a local file path. Resolves relative to CWD; mkdirs parent dirs; overwrites existing files.',

  async publish({
    copy,
    targetName,
    config,
  }: PublishArgs): Promise<ShipResult> {
    const parsed = configSchema.safeParse(config)
    if (!parsed.success) {
      return {
        ok: false,
        destinationName: targetName,
        adapterName: 'output-file',
        error: `invalid config for destination "${targetName}": ${parsed.error.message}`,
      }
    }

    try {
      const abs = resolve(process.cwd(), parsed.data.path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, copy, 'utf-8')

      return {
        ok: true,
        destinationName: targetName,
        adapterName: 'output-file',
        detail: `wrote ${copy.length} chars`,
        url: `file://${abs}`,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        destinationName: targetName,
        adapterName: 'output-file',
        error: msg,
      }
    }
  },
}
