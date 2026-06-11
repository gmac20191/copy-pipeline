/**
 * Model adapter layer.
 *
 * Maps brand-kit model IDs (e.g. `google/gemini-2.5-flash`) to Vercel AI SDK
 * language models. Provides one `generateVariant()` entry point that the
 * pipeline calls per candidate, with graceful failure when API keys are
 * missing — the failing model returns an explanatory placeholder variant
 * rather than crashing the run.
 *
 * Two auth families:
 *
 *  - Direct vendor APIs (`google/`, `anthropic/`, `openai/`) — vendor API
 *    keys via env (`GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY`,
 *    `OPENAI_API_KEY`). One key per vendor.
 *  - Google Cloud Vertex (`google-vertex/`, `anthropic-vertex/`) — Google
 *    Cloud credentials. Single auth path covers Gemini + Claude on Vertex
 *    Model Garden. Auth via Application Default Credentials or
 *    `GOOGLE_APPLICATION_CREDENTIALS` env (service account key JSON).
 *    Requires `GOOGLE_CLOUD_PROJECT` (project id) and optionally
 *    `GOOGLE_CLOUD_LOCATION` (default `us-central1`).
 *
 * Adding a provider = adding a case to `resolveLanguageModel()` and
 * importing the SDK adapter.
 */

import { generateText } from 'ai'
import { google } from '@ai-sdk/google'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { vertex } from '@ai-sdk/google-vertex'
import { vertexAnthropic } from '@ai-sdk/google-vertex/anthropic'

import type { ModelId, Variant } from '../types.js'

/**
 * Parse a brand-kit model ID and return a Vercel AI SDK language model handle.
 *
 * Expected shape: `<provider>/<model-name>`. Examples:
 *
 *   "google/gemini-2.5-flash"
 *   "anthropic/claude-opus-4-7"
 *   "openai/gpt-5"
 *   "google-vertex/gemini-2.5-flash"
 *   "anthropic-vertex/claude-haiku-4-5"
 *
 * For Vertex providers the `name` portion is the Vertex publisher model id
 * (e.g. `claude-haiku-4-5`, not `claude-haiku-4-5@20251001` — the SDK
 * handles versioning).
 *
 * Throws on malformed IDs and unknown providers — that's a brand-kit
 * authoring error, not a runtime concern that should be swallowed.
 */
function resolveLanguageModel(modelId: ModelId) {
  const slashIdx = modelId.indexOf('/')
  if (slashIdx < 0) {
    throw new Error(
      `invalid model id "${modelId}" — expected "provider/name" (e.g. "google/gemini-2.5-flash")`,
    )
  }
  const provider = modelId.slice(0, slashIdx)
  const name = modelId.slice(slashIdx + 1)
  if (!name) {
    throw new Error(`invalid model id "${modelId}" — empty name after "/"`)
  }

  switch (provider) {
    case 'google':
      return google(name)
    case 'anthropic':
      return anthropic(name)
    case 'openai':
      return openai(name)
    case 'google-vertex':
      return vertex(name)
    case 'anthropic-vertex':
      return vertexAnthropic(name)
    default:
      throw new Error(
        `unknown provider "${provider}" in model id "${modelId}" — supported: google, anthropic, openai, google-vertex, anthropic-vertex`,
      )
  }
}

const PROVIDER_KEY_HINT: Record<string, string> = {
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'google-vertex':
    'GOOGLE_CLOUD_PROJECT + GOOGLE_APPLICATION_CREDENTIALS (path to SA key) or `gcloud auth application-default login`',
  'anthropic-vertex':
    'GOOGLE_CLOUD_PROJECT + GOOGLE_APPLICATION_CREDENTIALS (path to SA key) or `gcloud auth application-default login`',
}

export interface GenerateVariantOptions {
  modelId: ModelId
  prompt: string
  variantId: string
  /** Optional system prompt — caller composes this from brand-kit + grounding. */
  systemPrompt?: string
  /** Optional generation params; sensible defaults applied. */
  temperature?: number
  maxTokens?: number
}

export async function generateVariant(
  opts: GenerateVariantOptions,
): Promise<Variant> {
  const { modelId, prompt, variantId, systemPrompt, temperature, maxTokens } =
    opts
  const startedAt = Date.now()

  try {
    const model = resolveLanguageModel(modelId)
    const result = await generateText({
      model,
      prompt,
      ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    })

    return {
      id: variantId,
      model: modelId,
      text: result.text,
      tokens: {
        prompt: result.usage.promptTokens ?? 0,
        completion: result.usage.completionTokens ?? 0,
      },
      latencyMs: Date.now() - startedAt,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const provider = modelId.split('/')[0] ?? '?'
    const keyHint =
      PROVIDER_KEY_HINT[provider] ?? 'the relevant provider env var'

    return {
      id: variantId,
      model: modelId,
      text: `[model call failed: ${modelId}]\n\n${msg}\n\nLikely cause: missing API credentials for "${provider}". Set ${keyHint} and retry.`,
      tokens: { prompt: 0, completion: 0 },
      latencyMs: Date.now() - startedAt,
    }
  }
}
