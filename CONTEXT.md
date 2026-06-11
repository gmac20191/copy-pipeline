# copy-pipeline

Brief → multi-model variants → graded → operator pick. Brand-kit-grounded
copy generation pipeline. The package is brand-agnostic; consuming
projects declare their own brand-kit.

## Language

**Brand-kit**:
A JSON file at `docs/brand/brand-kit.json` in the consuming project. Declares the brand canonical, named corpora, exemplars, model defaults, and destinations.
_Avoid_: style guide, brand book

**Brand canonical**:
The curated voice rules + invariants at the heart of the brand-kit (banned phrases, required phrasing, audience anchors, voice anchors).
_Avoid_: style guide, rules file

**Corpus**:
A named retrieval source declared in `brandKit.corpora.<handle>`. Has a `backend` (which adapter handles it) and an `index_name` (opaque physical identifier).
_Avoid_: index, collection, dataset

**Chunk**:
The unit of retrieval. One row in the vector store. Carries text, embedding, `source_path`, breadcrumb (heading path), and metadata.
_Avoid_: document, passage, snippet

**Embedder**:
The embedding model that converts chunks and queries into vectors. Declared in `brandKit.models.embedder`. Determines a corpus's vector dimension.
_Avoid_: encoder, vectorizer

**Backend**:
The adapter name that handles a corpus's reads and writes. Maps via `GROUNDING_REGISTRY` to a `GroundingSource` implementation. Today: only `pgvector`.
_Avoid_: provider, cloud, host

**Grounding**:
The act of retrieving chunks relevant to a brief and including them in the prompt the candidate model sees.
_Avoid_: RAG (too generic), retrieval

**Brief**:
The operator-supplied input — 1-3 sentences describing what to write, plus optional corpora to ground against and model overrides.
_Avoid_: prompt, query, request

**Variant**:
One candidate output from one model for one brief. Multiple variants per brief; the operator picks one.
_Avoid_: draft, generation, completion

**Grader**:
A scorer that runs over every variant. Today: `brand-review` (deterministic rule check) and `llm-judge` (voice judge). Each variant ends up with a composite score and a list of findings.
_Avoid_: validator, evaluator

**Judge**:
The LLM-specific grader (`llm-judge`). Use this term only for LLM-as-grader; generic scoring is "grader."

**Operator**:
The human running copy-pipeline. Authors briefs, picks among variants, ships to destinations. Today: solo dev. Longer term: content designer using a web UI.
_Avoid_: user, customer

**Destination**:
A target for shipped copy declared in `brandKit.destinations.entries`. Has an `adapter` (e.g. `output-file`, `git-commit-pr`) and adapter-specific config.
_Avoid_: target, output

**Preset**:
A source-format preprocessor on the ingester (e.g. `vanilla`, `hugo`). Strips or normalises source-specific syntax before chunking. Internal to the package — not declared in the brand-kit.
_Avoid_: profile, mode

**Pick**:
The operator's selected variant for a run. Becomes the gold label for downstream judge calibration and the source for canonical patches.
_Avoid_: choice, selection

**Claim**:
A product-behaviour assertion within a Variant that requires evidence — distinct from voice or brand compliance, which Graders cover. Wrapped in `<claim ref="prefix:body">text</claim>` HTML-passthrough tags in source markdown.
_Avoid_: assertion, statement, fact

**Evidence ref**:
A typed-string identifier of a verifiable source. Format `<prefix>:<body>`. The prefix routes to exactly one registered Verifier; the body is verifier-specific (a scenario id, an ADR slug, a file path, a corpus query, etc.).
_Avoid_: citation, reference, source-id

**Verifier**:
A registered plugin that resolves an Evidence ref to a Verdict. One Verifier per prefix. Sibling registry to Grader — but semantically distinct: Graders score whole Variants, Verifiers check individual Claims.
_Avoid_: validator, checker, resolver

**Verdict**:
A Verifier's output for a single Claim. One of `verified`, `unverified`, `error`. `error` means "couldn't check" (transient/network) — the gate treats it differently from `unverified`.
_Avoid_: result, status, outcome

**ClaimExtractor**:
A registered plugin that scans a Variant for product-behaviour Claims, proposes Evidence refs from the union of Verifier discoveries, and emits tagged markdown. Default flow is AI-extracted + human-confirmed; explicit author-tagging uses the same downstream machinery.
_Avoid_: tagger, annotator

**Discovery**:
A Verifier's optional enumeration of its current valid Evidence refs, used by the ClaimExtractor to compose its proposal menu. Verifiers with unbounded ref-spaces (e.g. corpus queries) skip discovery and accept arbitrary refs at verify time.
_Avoid_: enumeration, listing, indexing

**needs-evidence**:
A reserved Evidence ref prefix (no Verifier) for Claims the ClaimExtractor identified but couldn't match. The gate handles it distinctly from `unverified`: warn or block per consumer policy.
_Avoid_: untagged, unmatched, todo

## Relationships

- A **Brand-kit** declares one **Brand canonical**, zero or more **Corpora**, zero or more **Destinations**.
- Each **Corpus** uses exactly one **Backend** and exactly one **Embedder**.
- A **Backend** writes and reads **Chunks**.
- A **Brief** selects zero or more **Corpora** for **Grounding**.
- A **Brief** produces N **Variants** (one per candidate model in `brandKit.models.candidates`).
- Each **Variant** is scored by every **Grader** (one of which may be a **Judge**).
- A **Variant** may contain zero or more **Claims**, each tagged with an **Evidence ref**.
- A **ClaimExtractor** proposes Evidence refs for each Claim from the union of all registered **Verifiers**' **Discovery** outputs.
- An Evidence ref's prefix routes to exactly one **Verifier**, which produces a **Verdict**.
- An **Operator** **Picks** one **Variant**; the picked copy can be sent to one or more **Destinations**.

## Example dialogue

> **Dev:** "If I add a new **Corpus** to the brand-kit, do I need to run a migration?"
> **Engine:** "No — the **Backend** auto-creates its table on first ingest, sized to the **Corpus**'s **Embedder**."
> **Dev:** "What if two **Corpora** want different **Embedders**?"
> **Engine:** "Each gets its own table. **Embedder** dimension is per-corpus, not per-backend."
> **Dev:** "And if I switch a **Corpus** from OpenAI to BGE later?"
> **Engine:** "Dimension mismatch error — you `reindex` to drop + recreate. Re-embedding cost is yours to pay."

## Flagged ambiguities

- **"backend"** used to mean both *the cloud* (e.g. "GCP backend") and *the adapter name* (e.g. `backend: "gcp-vector-search"`). Resolved: **Backend** = adapter name. The cloud (if any) is just "the cloud."
- **"index"** used to mean both Vertex AI Vector Search index resources and pgvector HNSW SQL indexes. Resolved: a **Corpus** is the user-facing named retrieval source; "index" is reserved for the SQL HNSW index on the embedding column. The brand-kit field is still `index_name` for backward compatibility — read it as "opaque backend identifier."
- **"judge"** vs **"grader"**: a **Grader** is any scorer (deterministic or LLM); a **Judge** specifically means the LLM-based grader. Don't use "judge" generically.
