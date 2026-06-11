# `@gmac20191/copy-pipeline`

[![CI](https://github.com/gmac20191/copy-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/gmac20191/copy-pipeline/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/gmac20191/copy-pipeline?sort=semver)](https://github.com/gmac20191/copy-pipeline/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

Brief → multi-model variants → graded → operator pick → shipped. Plus claim verification: every tagged assertion in published copy resolves to a verified source.

## Status

**Alpha** — three sets of capabilities are wired end-to-end:

1. **Generation + grading** — brief in, multi-model variants out, brand-canonical + LLM-judge graders run on each.
2. **Grounding** — pgvector + provider-agnostic embeddings (ADR `docs/adr/0001-grounding-stack.md`). Markdown ingester live; Langfuse tracing live.
3. **Claim verification** — `<claim ref="prefix:body">text</claim>` tags inline in content get dispatched to per-prefix Verifiers (file, code-symbol, NotebookLM corpus, plus consumer-side extensions for eval-scenario / ADR / snapshot refs). Includes an optional LLM-as-judge step for corpus-based claims (ADR `docs/adr/0002-claim-verification.md`).

Each capability degrades gracefully when its env or external dependencies are missing. See "What's wired up" + [CHANGELOG.md](./CHANGELOG.md).

## What this is

A brand-agnostic content pipeline that takes a 1-3 sentence brief and a brand-kit, generates N candidate drafts in parallel across multiple LLM vendors, grades each variant deterministically (rule checks) and via an LLM judge, optionally tags product-behaviour and science claims for verification against project-specific sources of truth, and presents the ranked variants for an operator to pick + edit + ship. Every run traces to Langfuse. The operator's pick is the gold label.

Each consuming project declares its own `docs/brand/brand-kit.json` (canonical specs, corpora, exemplars, model defaults, destinations) and registers its own project-specific Verifiers. The core stays brand-free.

Typical use cases:

- Marketing copy generation grounded in a project's CANONICAL.md / voice spec
- Long-form blog content where claims need to verify against research corpora (NotebookLM) and product code (eval scenarios, ADRs)
- Tech documentation where product-feature assertions must resolve against the codebase
- Jira description rewrites / PR descriptions / customer-facing release notes
- Future sibling use cases plug in via the `Grader` / `GroundingSource` / `Verifier` / `ClaimExtractor` / `DestinationAdapter` interfaces.

## Architecture

Five-stage pipeline with five registries:

```
Brief
  │
  ▼
┌─ Stage 1: Grounding ────────────────────────────────────┐
│   GroundingSource registry retrieves chunks from corpora │
│   • pgvector  (default; ADR 0001)                        │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌─ Stage 2: Generation ───────────────────────────────────┐
│   N variants × M models in parallel via Vercel AI SDK    │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌─ Stage 3: Claim extraction (optional) ──────────────────┐
│   ClaimExtractor registry — LLM-driven default          │
│   Identifies product-behaviour claims, proposes refs    │
│   from the union of registered Verifiers' discover()    │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌─ Stage 4: Grading ──────────────────────────────────────┐
│   Grader registry — brand-review (rules) + LLM judge    │
└──────────────────────────────────────────────────────────┘
  │
  ▼
┌─ Stage 5: Claim verification ───────────────────────────┐
│   Verifier registry routes by prefix; per-claim verdict │
│   • file              (built-in; checks workspace path) │
│   • notebooklm        (built-in; corpus + optional LLM  │
│                        judge step)                       │
│   • <project-specific> (consumer-registered at startup) │
└──────────────────────────────────────────────────────────┘
  │
  ▼
Operator picks
  │
  ▼
┌─ Stage 6: Destination ──────────────────────────────────┐
│   DestinationAdapter registry — output-file, git-commit │
└──────────────────────────────────────────────────────────┘
```

The mental model: each stage has a registry; consumers extend each via `register*()`. Project-specific plugins live in the consumer's repo (e.g. a `copy-pipeline-plugins` package in the consuming monorepo) and register at consumer startup.

The eleven load-bearing decisions:

1. Workflow: Brief → N variants → operator picks/edits → Langfuse trace
2. Brand contract: `brand-kit.{ts,json}` per consuming project
3. Corpus composition: per-call, multi-corpus, source-tagged retrieve-merge
4. Variant axis: different *models*, same prompt
5. Grading: deterministic rules + LLM judge (distinct from candidates) + operator pick
6. Artifact shape: TS library + thin CLI shell + Skill wrapper
7. Repo: standalone (this repo); project-specific plugins live in the consumer repo
8. Retrieval: pgvector + provider-agnostic embeddings (OpenAI default, brand-kit-configurable). See ADR `docs/adr/0001-grounding-stack.md`.
9. Identity: `@gmac20191/copy-pipeline`, CLI binary `copy-pipeline`
10. Claim verification: HTML-passthrough `<claim ref="prefix:body">text</claim>` tags; per-prefix Verifiers; ADR `docs/adr/0002-claim-verification.md`
11. NotebookLM verifier: weak verdict by default (citations-presence); opt-in LLM-as-judge step for proper claim-vs-corpus interpretation

## Install

Not published to npm. Install from git (pin a release tag):

```bash
npm install github:gmac20191/copy-pipeline#v0.1.0
# or
pnpm add github:gmac20191/copy-pipeline#v0.1.0
```

Release tags are listed on the [releases page](https://github.com/gmac20191/copy-pipeline/releases).

Then declare your project's brand-kit at `docs/brand/brand-kit.json`. Schema in `src/brand-kit.ts`.

## Local stack

The pipeline needs a Postgres+pgvector instance to retrieve from. A `docker-compose.yml` brings up pgvector and Langfuse together.

```bash
npm run stack:up        # pgvector (port 5432) + Langfuse (http://localhost:3104)
npm run stack:down      # stop, preserve volumes
docker compose down -v  # nuke data too
```

The bundled Langfuse auto-provisions on first boot:

- Org / project: `copy-pipeline`
- Public key: `pk-lf-copy-pipeline-dev`
- Secret key: `sk-lf-copy-pipeline-dev`
- Admin user: `admin@copy-pipeline.local` / `admin1234`

Point copy-pipeline at the bundled stack:

```bash
export DATABASE_URL="postgres://copy_pipeline:copy_pipeline@localhost:5432/copy_pipeline"
export LANGFUSE_PUBLIC_KEY="pk-lf-copy-pipeline-dev"
export LANGFUSE_SECRET_KEY="sk-lf-copy-pipeline-dev"
export LANGFUSE_BASE_URL="http://localhost:3104"
```

> ⚠️ The bundled defaults are intentionally insecure — local dev only. Do not reuse in any other environment.

## CLI

```bash
copy-pipeline gen --brief "..." --ground voice,science
copy-pipeline index <corpus> --from <path-or-glob>
copy-pipeline ship --destination scratch --copy-from /tmp/picked.md
copy-pipeline pick <run-id>       # stub

# Claim verification
copy-pipeline verify path/to/post.md                                  # built-in verifiers (file)
copy-pipeline verify post.md --with-notebooklm --notebook-id <uuid>  # add NotebookLM corpus
copy-pipeline verify post.md --plugin ./my-verifiers.ts --json       # consumer plugin + JSON
# Exit codes: 0 verified or needs-evidence only; 1 any unverified; 2 any error
```

## Library

```ts
import { generate } from "@gmac20191/copy-pipeline";
import { loadBrandKit } from "@gmac20191/copy-pipeline/brand-kit";

const brandKit = await loadBrandKit();
const result = await generate({
  brief: "Blog hero for the freestyle feature",
  ground: ["voice", "science"],
  brandKit,
});
```

## What's wired up

| Component | Status |
|---|---|
| Package scaffolding (TS config, package.json, exports, build) | ✅ |
| Brand-kit Zod schema + walk-up autodiscovery | ✅ |
| `Grader` interface + registry + `defaultGraders()` | ✅ |
| `GroundingSource` interface + registry + `defaultGroundingSources()` | ✅ |
| `DestinationAdapter` interface + registry + `defaultDestinations()` | ✅ |
| `Verifier` interface + registry + dispatcher | ✅ |
| `ClaimExtractor` interface + registry | ✅ |
| `generate()` — real fan-out via Vercel AI SDK | ✅ (graceful no-key fallback) |
| Model adapters — google / anthropic / openai | ✅ |
| brand-review grader (subprocess shell-out to the skill) | ✅ |
| LLM voice judge grader | ✅ |
| LLM claim extractor (uses `brandKit.models.grader`) | ✅ (injectable call for tests) |
| `file` verifier — workspace path existence check | ✅ |
| `notebooklm` verifier — shells out to the notebooklm-query skill | ✅ (live-confirmed) |
| LLM-as-judge step on the NotebookLM verifier | ✅ (opt-in, claim-vs-corpus interpretation) |
| Claim verification dispatcher (parse tags, route by prefix, aggregate) | ✅ |
| pgvector `GroundingSource` adapter — retrieve + write | ✅ (graceful no-`DATABASE_URL` fallback) |
| Markdown ingester (heading-based chunker + frontmatter parser) | ✅ |
| Embedder resolver (`brandKit.models.embedder`) — OpenAI default | ✅ |
| Grounded system-prompt composition (chunks injected into prompt) | ✅ |
| Langfuse trace emission | ✅ (bundled in `npm run stack:up`) |
| Local dev stack (`docker-compose.yml`) — pgvector + Langfuse | ✅ |
| CLI `gen` — generate + grade + ranked output | ✅ |
| CLI `index <corpus> --from <path>` — ingest + write | ✅ (vanilla preset) |
| CLI `ship` — publish picked copy via a destination adapter | ✅ |
| CLI `verify <file>` — claim verification with `--plugin` extension | ✅ |
| `output-file` + `git-commit-pr` destinations | ✅ |
| `atlassian-mcp` / `slack-mcp` destinations | 🟡 stubs |
| CLI `index --preset hugo` (Hugo shortcode stripping) | 🟡 issue #4 |
| CLI `reindex <corpus>` — drop + recreate on dimension change | 🟡 issue #4 |
| CLI `pick` — record operator pick in Langfuse | 🟡 stub |
| V2 web UI (content-author workflow) | ❌ — out of scope for the engine |

See [CHANGELOG.md](./CHANGELOG.md) for the per-version breakdown.

## Daily-use workflow

```bash
# 1. Generate variants. Output as JSON to a file:
copy-pipeline gen \
  --brief "Blog hero for the new freestyle feature, audience: serious lifters" \
  --ground voice,science \
  --json > /tmp/run.json

# 2. Pick the variant you want. (Until v0.3 ships `pick`, do this by hand):
jq -r '.graded[0].variant.text' /tmp/run.json > /tmp/picked.md

# 3. Edit in your editor of choice (and add <claim ref="..."> tags around
#    product-behaviour or science assertions you want to gate at publish):
$EDITOR /tmp/picked.md

# 4. Verify every tagged claim resolves:
copy-pipeline verify /tmp/picked.md \
  --with-notebooklm --notebook-id <uuid> \
  --plugin ./my-project/copy-pipeline-plugins.ts

# 5. Ship to a destination from your brand-kit:
copy-pipeline ship --copy-from /tmp/picked.md --destination scratch
# → ✓ shipped to "scratch" via output-file (wrote 374 chars)
#   → file:///tmp/copy-pipeline-out.md
```

Set the env vars from [.env.example](./.env.example) to enable the components you want. Each component degrades gracefully when its env is missing.

## Companion skill

For agent-discoverability, install `~/.claude/skills/copy-pipeline/SKILL.md` that wraps the CLI. Currently bundled in `skill/SKILL.md` (TBD).

## Don't duplicate documentation

This README is intentionally short. Architecture lives in this repo's `docs/adr/`; the consuming project's brand canonical lives in *its* repo.

In this repo:

- `docs/adr/0001-grounding-stack.md` — pgvector + provider-agnostic embeddings (supersedes the Vertex half of any prior consumer-side architecture ADR)
- `docs/adr/0002-claim-verification.md` — tagged-markdown claim verification + Verifier + ClaimExtractor + CloudCannon spike findings + NotebookLM judge step
- `docs/AUTHORING.md` — how to write tagged content so CMS editors don't destroy the markers (Source Editor vs WYSIWYG)
- `CONTEXT.md` — domain glossary for the package (Brief, Variant, Grader, Verifier, Claim, Evidence ref, etc.)

In each consuming project:

- `docs/brand/brand-kit.json` — the brand-kit the pipeline consumes
- `docs/brand/CANONICAL.md` — the canonical voice / audience spec the brand-kit references
- Project-specific Verifier plugins (e.g. `packages/copy-pipeline-plugins/` in a yarn monorepo) registered at consumer startup

## Contributing & versioning

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Short version: GitHub Flow (topic branches → squash-merged PRs into `main` with conventional-commit titles), and versioning is fully automated — on every push to `main`, semantic-release derives the next semver from the commit types, tags it, and publishes a GitHub Release with generated notes.

## License

[Apache-2.0](./LICENSE)
