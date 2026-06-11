/**
 * Preset registry — maps a preset name to a Markdown preprocessor that runs
 * before chunking.
 *
 * Adding a new preset is a single import + entry below. Brand-kit authors
 * don't declare transformers; presets live inside the package (per ADR 0001).
 */

import { hugoPreprocess } from './hugo.js'

export type IngestPreset = 'vanilla' | 'hugo'

export type Preprocessor = (markdown: string) => string

const REGISTRY: Record<IngestPreset, Preprocessor> = {
  vanilla: (md) => md,
  hugo: hugoPreprocess,
}

export function resolvePreset(name: IngestPreset): Preprocessor {
  const fn = REGISTRY[name]
  if (!fn) {
    throw new Error(
      `unknown preset "${name}". Supported: ${Object.keys(REGISTRY).join(', ')}.`,
    )
  }
  return fn
}

export const PRESET_NAMES = Object.keys(REGISTRY) as IngestPreset[]
