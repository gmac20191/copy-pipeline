# Grounding stack: pgvector + provider-agnostic embeddings

## Status

Accepted — 2026-05-21.

Supersedes the vector-store and embeddings halves of the first consumer's
`docs/decisions/2026-05-19-copy-pipeline-architecture.md` decisions 5
and 8 (Vertex AI Vector Search + Google embeddings).

## Decision

The grounding stack is **pgvector** for storage and **provider-agnostic
embeddings via `brandKit.models.embedder`**, defaulting to OpenAI
`text-embedding-3-small`.

- **Storage**: pgvector. One Postgres table per corpus (`chunks_<corpus>`).
  Schema auto-created on first ingest, with the vector column's dimension
  derived from the corpus's embedder.
- **Embeddings**: brand-kit-configurable. Default
  `openai/text-embedding-3-small`. Operators can declare `voyage/voyage-3`
  for higher retrieval quality, or any other supported embedder. No
  Google embeddings. Fully-offline embedders (e.g. BGE via a local
  runtime) are not bundled but the brand-kit field doesn't preclude a
  consumer wiring one up themselves.
- **Backend interface**: `GroundingSource` gains a `write(chunks, indexName)`
  method; pgvector implements both `retrieve` and `write`. The Vertex AI
  Vector Search adapter is deleted; `@google-cloud/aiplatform` drops from
  runtime dependencies.
- **Local stack**: `docker-compose.yml` brings up pgvector + Langfuse via
  `npm run stack:up`. One command for the dev surface.
- **Connection string**: `DATABASE_URL` (env). Brand-kit stays
  infrastructure-agnostic — same principle as the previous Vertex adapter's
  env-driven config.
- **Versioning**: not modelled at the chunk level. A corpus is implicitly
  "whatever the source pointed to at last ingest." Multi-version grounding,
  if ever needed, is expressed as separate corpora — no schema change.

## Why

That original ADR locked Vertex AI Vector Search and Google embeddings on the
argument that they were "primitives" with low lock-in. In practice both
pull the project into Google's orbit:

- Vertex Vector Search requires GCP project setup, IAM, and index endpoint
  deployment via console. Local dev needs `gcloud auth` for the embedder
  step.
- Google embeddings produce vectors that only matter if the same model
  embeds queries — coupling consumers to Google for the *lifetime* of any
  indexed corpus (re-embedding is the cost of leaving).

pgvector is the same "just a primitive" argument with strictly less
lock-in. It lives in any Postgres (Supabase, Neon, RDS, self-hosted),
supports SQL-native filtering, and the operational surface is "Postgres"
— skills any consumer already has.

OpenAI embeddings are the new default because picking *any* default has
the same swappable-via-brand-kit escape hatch. The brand-kit field is the
actual contract; today's default is a starting point, not a commitment.

## Chunking and ingestion

- **Boundary**: heading-based (H2 first, fall back to H3, then paragraph).
- **Size**: ~1000 tokens per chunk.
- **Breadcrumb**: `H1 > H2 > H3` prepended into the embedded text.
- **Code blocks and tables**: atomic — never split through a fence or
  table row.
- **Overlap**: none. Heading-based chunking doesn't need it.
- **Source format handling**: a `--preset` flag on the ingester picks the
  preprocessor — `vanilla` (default) or `hugo` (strips `{{< … >}}`
  shortcodes). Adding a preset is a package-internal concern; brand-kit
  authors don't declare transformers.

## What this changes in code

- `src/grounding/pgvector.ts` (new) — implements `GroundingSource` including
  `write`.
- `src/grounding/gcp-vector-search.ts` (deleted).
- `src/grounding/index.ts` — `GroundingSource` gains a `write` method;
  `defaultGroundingSources()` returns the pgvector adapter.
- `src/grounding/ingest.ts` (new) — brand-agnostic Markdown ingester with
  a `--preset` flag.
- `src/grounding/chunker.ts` (new) — pure heading-based chunker.
- `src/grounding/embed.ts` (new) — embedder resolver reading
  `brandKit.models.embedder`.
- `bin/copy-pipeline.ts` — `index` subcommand stub becomes real; new
  `reindex` subcommand for explicit drop + recreate.
- `docker-compose.yml` (new) — pgvector + Langfuse.
- `package.json` — adds `npm run stack:up`; drops `@google-cloud/aiplatform`;
  adds `pg`, `pgvector` (npm client), `openai` (or whichever embedder
  client we ship by default).

## What this does not change

The pluggable interface stays pluggable. A consumer who later wants
Pinecone, Qdrant, Weaviate, or LanceDB can add a sibling adapter without
touching anything above the `GroundingSource` interface. The operating
principle is "don't ship a second implementation until a real second user
appears," not "only one backend, ever."

## Considered and rejected

- **Qdrant**: open-source, single-binary Docker, excellent TS client.
  Rejected for v0 — Postgres is already coming for the longer-term
  workspaces/runs/annotations surface; adding a second service for the
  vector store earns no compounding benefit.
- **One global `chunks` table with a `corpus` column**: locks all corpora
  to one embedder dimension. Re-introduces the lock-in concern one level
  down.
- **Multi-version corpora as a schema feature**: deferred. If a consumer
  needs cross-version grounding, they declare separate corpora per
  version.
- **Keeping the Vertex adapter as a sibling**: deleted instead. Greenfield
  + explicit lock-in concern make "two implementations to validate the
  interface" cost more than it earns. A second backend re-enters the tree
  the day a real second user appears.
- **Bundling Ollama for offline embeddings**: considered for an `offline`
  docker-compose profile, dropped as YAGNI. The brand-kit field still
  allows a consumer to swap to BGE or any other embedder and run their
  own local runtime, but copy-pipeline doesn't ship one.
