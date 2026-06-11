# Consumer onboarding checklist

How a new project — content team, engineering team, marketing org — gets copy-pipeline running end-to-end against their own brand-kit + evidence sources.

This document is brand-agnostic. Worked examples use a hypothetical `@acme/copy-pipeline-plugins` package; new consumers should mirror its shape.

## The five steps

A new consumer needs five artefacts in their repo. Reference templates in `docs/consumer-templates/`.

### 1. Brand-kit

`docs/brand/brand-kit.json` at the consumer's repo root (or anywhere `loadBrandKit()`'s walk-up finder will hit it). Template at [`docs/consumer-templates/brand-kit.example.json`](./consumer-templates/brand-kit.example.json).

Required fields: `name`, `version`, `canonicals.<surface>.spec`, `models.candidates`, `models.grader`. Everything else is optional.

For content-team consumers: the `models.grader` model is also the LLM used by the voice judge and the NotebookLM LLM-as-judge step. Anthropic's Claude Sonnet is the safe default; Google's Gemini Pro is a reasonable alternative.

### 2. Brand canonical

`docs/brand/CANONICAL.md` — the voice spec the brand-review grader scores variants against. Template at [`docs/consumer-templates/CANONICAL.example.md`](./consumer-templates/CANONICAL.example.md).

Sections that matter to graders:

- **§ Audience** — who the copy is for; voice cues should land naturally
- **§ Voice** — three rules (positive direction); short, declarative
- **§ Do / Don't** — concrete examples + the explicit no-no list
- **§ Banned phrases** — exact strings the brand-review grader will fail on

For non-content-team teams (engineering deliverables — PR descriptions, release notes), this can be thinner. The grader still runs but the bar is lower.

### 3. Project-specific Verifier plugin pack

A package in the consumer repo that exports project-specific `Verifier` objects + a `registerAll()` helper. Template at [`docs/consumer-templates/plugin-pack/`](./consumer-templates/plugin-pack/).

The shape consumers should follow:

```
<consumer-repo>/packages/copy-pipeline-plugins/
├── package.json                  // source-only; depends on @gmac20191/copy-pipeline
├── tsconfig.json                 // extends the consumer's shared TS config
├── README.md                     // documents which verifiers ship + ref formats
└── src/
    ├── index.ts                  // exports verifiers + registerAll(register)
    ├── <evidence-type-a>.ts      // e.g. eval-scenario.ts, jira-ticket.ts
    ├── <evidence-type-b>.ts      // e.g. snapshot.ts, confluence-page.ts
    └── <evidence-type-c>.ts      // e.g. adr.ts, feature-flag.ts
```

Each verifier follows the `Verifier` interface from `@gmac20191/copy-pipeline`:

```ts
export const myVerifier: Verifier = {
  prefix: 'my-prefix',
  name: 'consumer-my-prefix',
  description: '...',
  async verify(args, ctx) { /* return VerifyResult */ },
  async discover?(ctx) { /* return DiscoveredRef[] */ },
}
```

Common evidence types to consider for a content team:

- `feature-flag:<key>` — verifies a feature claim against the flag's actual current state
- `api-endpoint:<route>` — verifies a "the product supports endpoint X" claim
- `confluence-page:<id>` — verifies a "documented at X" claim
- `jira-ticket:<key>` — verifies a "tracked in X" claim
- `code-symbol:<path>#<symbol>` — verifies a "this function exists" claim

For engineering teams: code-grep verifiers, test-result verifiers (last-passing CI run), deployment-state verifiers.

### 4. Brand-kit plugin declaration

Wire the plugin pack into the brand-kit so the CLI + MCP server auto-load it:

```jsonc
{
  "name": "<consumer>",
  "version": "...",
  "canonicals": { /* ... */ },
  "models": { /* ... */ },
  "verifiers": {
    "plugins": ["@consumer/copy-pipeline-plugins"],
    "builtins": {
      "notebooklm": true,
      "notebooklm_notebook_id": "<uuid>"
    }
  }
}
```

After this, `copy-pipeline verify <file>` from inside the consumer's repo loads everything it needs without flags.

### 5. CMS-side authoring config (if applicable)

If the consumer authors content in a CMS, the CMS needs to be told about the `<claim>` HTML-passthrough tag. Otherwise the WYSIWYG view will either strip the tag or render it as a non-editable placeholder.

- **CloudCannon** — see [`docs/CLOUDCANNON.md`](./CLOUDCANNON.md). Minimum-viable recipe sets `_editables.content.allow_custom_markup: true`. Run the round-trip spike against the consumer's site before rolling out to authors.
- **Other CMSs** — the relevant config key is "allow custom HTML elements in rich text" / "snippet registration for custom inline elements". Find the equivalent in your CMS's docs.
- **Direct git workflow (no CMS)** — no action needed. Authors edit markdown files directly. Tags pass through unchanged.

## Verifying the on-ramp

After the five artefacts are in place:

```bash
# From the consumer's repo root, with a tagged markdown file ready:
copy-pipeline verify path/to/draft.md

# Expected: built-in file verifier + brand-kit-declared notebooklm +
# plugin-pack verifiers all load. Per-claim verdicts printed. Exit
# code 0 if all verified or needs-evidence only; 1 if any unverified;
# 2 if any error.
```

If the CLI errors out:

| Symptom | Likely cause |
|---|---|
| `unknown verifier for prefix '<x>'` | Plugin pack module name wrong in brand-kit, or the plugin pack's `src/index.ts` doesn't export the verifier object |
| `Langfuse not configured` (warning, not fatal) | `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` env vars unset; pick recording skipped, generation still works |
| `notebooklm-query exited 1: could not locate Query box` | NotebookLM browser auth expired; re-bootstrap the profile per the notebooklm-query skill |
| `loadBrandKit … not found` | `docs/brand/brand-kit.json` missing or not walking-up from CWD; pass `--brand-kit <path>` |

## Content-team workflow

1. Author writes prose in the CMS's Source Editor (or markdown view).
2. AI extractor (separate workflow, the `ClaimExtractor`) tags claims with `<claim ref="...">` markers.
3. Reviewer accepts/edits the tags.
4. `copy-pipeline verify <file>` is run pre-publish — usually wired as a CI gate on the source repo.
5. If any claim is `unverified`, the publish blocks; reviewer either revises the prose, picks a different evidence ref, or marks it `needs-evidence:` to ship as unanchored (gate-warn).

## Engineering-team workflow (PR descriptions, release notes)

1. Engineer drafts the PR description.
2. `copy-pipeline gen --brief "<short brief>"` produces variants.
3. Engineer picks one, edits, ships via `copy-pipeline ship --destination jira-pr-description`.
4. (Optional) Tagged claims about feature behaviour get verified against code-symbol / feature-flag / test-result verifiers before merge.

## Maintenance after on-ramp

- When a new evidence type emerges (new system to verify against), add a Verifier to the plugin pack. The brand-kit doesn't need to change.
- When the brand canonical evolves, the brand-review grader picks it up on next run.
- When the NotebookLM corpus gains sources, the notebooklm verifier picks them up on next query.
- When the consumer wants stricter claim-vs-corpus interpretation, configure the LLM-as-judge step on the NotebookLM verifier (see ADR 0002).
