# Changelog

> **Frozen at 0.1.0.** From v0.1.0 onward, releases are automated with
> semantic-release and release notes live on the
> [GitHub releases page](https://github.com/gmac20191/copy-pipeline/releases).
> This file is the hand-written pre-release (alpha) history.

Architectural references point at the ADR in the originating consuming
project's repo (`docs/decisions/<date>-copy-pipeline-architecture.md`).
This file just tracks shipped-state evolution; rationale lives in the ADR.

## 0.1.0-alpha.7 — 2026-05-20

First real destination adapter beyond `output-file`.

### Added

- `git-commit-pr` destination adapter — real implementation
  (`src/destination/git-commit-pr.ts`). Was a stub; now writes copy to a
  path in a local git repo, creates a feature branch, commits. Optional
  push + `gh pr create` behind `config.open_pr` (default false, conservative).
- Pre-flight: rejects non-absolute repo paths, missing repos, non-git
  working trees, dirty working trees (unless `allow_dirty=true`), and
  missing `gh` CLI when `open_pr=true`. Returns `ok: false` rather than
  throws — keeps the CLI predictable.
- Conservative defaults: `open_pr=false`, `draft_pr=true`,
  `push_remote=origin`, `base_branch=main`. Branch name pattern:
  `${branch_prefix}${slug}-${unix_seconds}` (uniqueness via timestamp).
- 8 unit tests against a real ephemeral git repo per case. Covers all
  pre-flight failure modes + happy path + nested-dir creation +
  `allow_dirty` bypass + `gh`-absent error.

### Changed

- `defaultDestinations()` description in `destination/index.ts` reflects
  that `git-commit-pr` is real now; only `atlassian-mcp` + `slack-mcp`
  remain as stubs.

## 0.1.0-alpha.6 — 2026-05-20

V1 surface feature-complete for solo-operator daily use. Destination layer
shipped; output-file adapter is real and round-trips end-to-end.

### Added

- `DestinationAdapter` interface + registry + `defaultDestinations()` factory
  (`src/destination/index.ts`). Mirror of the Grader / GroundingSource pattern.
- `output-file` destination adapter (`src/destination/output-file.ts`). Real
  implementation: validates config via Zod, mkdir's parent dirs, writes the
  picked copy to a path relative to CWD.
- Three stub adapters that explain themselves: `git-commit-pr`, `atlassian-mcp`,
  `slack-mcp`. Real wiring deferred to V2.
- `ship()` library function (`src/ship.ts`) that the CLI wraps.
- `copy-pipeline ship` CLI subcommand. Accepts `--copy-from <path>` or
  `--paste` (stdin) plus `--destination <name>` (key from
  `brand-kit.destinations.entries`). `--json` for machine output.
- Brand-kit Zod schema validates destination entries (`adapter`, `config`,
  optional `description`).
- `.env.example` documenting the full env var matrix.

### Wired

- The first consuming project's `docs/brand/brand-kit.json` declares two
  `output-file` destinations (`scratch` → `/tmp/copy-pipeline-out.md`,
  `draft` → `_drafts/...`).

## 0.1.0-alpha.5 — 2026-05-20

### Added

- Vertex AI Vector Search `GroundingSource` adapter
  (`src/grounding/gcp-vector-search.ts`). Real two-step retrieval via
  `PredictionServiceClient` (embed) + `MatchServiceClient` (findNeighbors).
  Reads GCP env: `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_REGION` /
  `GOOGLE_VECTOR_SEARCH_ENDPOINT`. Graceful fallback when missing.
- `defaultGroundingSources()` factory mirroring `defaultGraders()`.
- `retrieveGrounding()` in `generate.ts` dispatches per `--ground` handle,
  silently skips deferred corpora, surfaces unknown corpora as explanatory
  chunks.
- `buildSystemPrompt()` now composes real grounded prompts — retrieved
  chunks are injected source-tagged (`── source: voice (3 chunks) ──`).
- `GenerationRun.groundingChunks` is now populated (was always `[]`).

## 0.1.0-alpha.4 — 2026-05-20

### Added

- Langfuse trace emission (`src/tracing/langfuse.ts`). One trace per gen run
  with nested `generation` spans per model call (input/output/tokens/latency)
  and `span` + `score` per grader invocation per variant. Reads
  `LANGFUSE_PUBLIC_KEY` / `SECRET_KEY` / `BASE_URL` / `RUN_LABEL`. No-op
  tracer when env vars missing.

## 0.1.0-alpha.3 — 2026-05-20

### Added

- LLM voice judge grader (`src/grader/llm-judge.ts`). `generateObject` with a
  four-dimension Zod schema (anchored / on-tone / audience-calibration /
  no-companion-leak). Uses `brand-kit.models.grader` — must be distinct from
  any candidate to limit self-judging bias.

## 0.1.0-alpha.2 — 2026-05-20

### Added

- Real model fan-out via Vercel AI SDK (`src/models/index.ts`). Parallel calls
  to each `brand-kit.models.candidates` entry via `@ai-sdk/google`,
  `@ai-sdk/anthropic`, `@ai-sdk/openai`. Graceful no-API-key fallback returns
  explanatory placeholder text.
- `buildSystemPrompt()` v1 in `generate.ts` — minimal brand-aware system
  prompt referencing the canonical spec.

## 0.1.0-alpha.1 — 2026-05-20

### Added

- brand-review grader (`src/grader/brand-review.ts`). Shells out to the
  brand-review skill at `~/.claude/skills/brand-review/review.sh --json
  --paste`. Don't-duplicate-canonical principle in working code.
- `defaultGraders()` factory.
- `generate()` actually calls graders; variants sorted highest-score-first.

## 0.1.0-alpha.0 — 2026-05-20

### Added

- Initial scaffolding. TS package with declared deps (Vercel AI SDK +
  provider adapters, langfuse, `@google-cloud/aiplatform`, commander, zod).
- Strict ESM NodeNext TypeScript config.
- Brand-kit Zod schema + walk-up autodiscovery
  (`src/brand-kit.ts::findBrandKitPath()` + `loadBrandKit()`).
- `Grader` + `GroundingSource` interfaces with registries.
- Stub `generate()` returning fake variants — replaced in subsequent commits.
- CLI shell with `gen` / `index` / `pick` subcommands (`bin/copy-pipeline.ts`).
- README pointing at the consuming project's ADR (don't-duplicate principle for docs).
