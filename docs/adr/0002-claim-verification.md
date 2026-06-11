# Claim verification via tagged markdown and per-verifier discovery

## Context

copy-pipeline today grades **Variants** for voice and brand-canonical compliance via `Grader` plugins. It does not verify *product-behaviour claims* — assertions in copy about how the product actually behaves ("this feature integrates with Active Directory via SCIM 2.0", "the dashboard auto-detects regressions and rolls back").

Multiple consumer projects need this — long-form marketing content (claims about product behaviour) and tech docs (claims about feature capabilities). Some consumers already ground subjective claims via research corpora and style-trained models; none has a mechanism to keep product-behaviour claims true as the product evolves. Silent drift between docs and reality is the dominant failure mode.

## Decision

Add **claim verification** as a first-class pipeline stage. Five elements:

1. **Tagged claims in markdown.** Claims are wrapped in `<claim ref="prefix:body">text</claim>` HTML-passthrough tags. Universal markdown — preserved by every processor (Hugo, Jekyll, MDX, CommonMark), every WYSIWYG, GitHub view. Decoupled from any specific SSG or CMS. Reader-facing receipts render via pure CSS.

2. **`Verifier` is a new registry,** sibling to `GroundingSource`, `Grader`, and `Destination`. Each Verifier owns a unique routing prefix (`eval:`, `adr:`, `code:`, `notebooklm:`, ...) and returns one of three **Verdicts**: `verified`, `unverified`, `error`. Verification is per-claim and semantically distinct from variant grading.

3. **`ClaimExtractor` is a new registry** that runs after generation. For each Variant, it identifies product-behaviour claims and proposes Evidence refs from the union of Verifier `discover()` results. Unmatched claims are tagged with the reserved `needs-evidence:` prefix and surfaced at the gate. AI-extracted + human-confirmed is the default flow for non-engineer authors (e.g. a content team); explicit-tag-by-author works equally on the same machinery.

4. **Project-specific Verifiers register at consumer startup,** not in copy-pipeline. A content-site consumer might ship `eval-scenario`, `snapshot`, `adr` verifiers from its own repo; a tech-docs consumer might ship `feature-flag`, `api-endpoint`, `confluence-page` verifiers from its repo. copy-pipeline core ships only the brand-agnostic verifiers (`file`, `code-symbol`, `notebooklm-claim`).

5. **Discovery lives per-Verifier,** not in a central manifest. Each Verifier optionally exposes its current valid Evidence refs via `discover()`. The ClaimExtractor unions these to compose its proposal menu. Bounded ref-spaces (eval scenarios, ADRs) implement discovery; unbounded ones (free-form corpus queries) accept arbitrary refs and verify at runtime.

## Considered alternatives

- **Verification as a `Grader`.** Rejected: Graders produce a 0-1 score over a whole Variant; verification is per-claim binary. Forcing one into the other corrupts both shapes.
- **One unified connector with both `retrieve()` and `verify()`.** Rejected: forces every backend to fake one of the methods. `stdin` can ground but not verify; `eval-scenario` can verify but isn't a generation source. Two interfaces sharing backend code handles asymmetric backends cleanly.
- **Central declared manifest of valid Evidence refs.** Rejected: drifts from reality silently; another file to maintain. Per-Verifier discovery is self-updating from source-of-truth.
- **MDX `<Claim>` JSX components.** Rejected: couples to React/MDX. Won't survive WYSIWYG round-trip in non-MDX CMSs (CloudCannon, Confluence).
- **Hugo shortcodes.** Rejected: couples to Hugo. HTML passthrough is SSG-agnostic.
- **Workspace monorepo for plugins.** Deferred. Single package with optional peer deps covers current plugin count; carve workspaces when separately-released plugins or third-party authors materialise.
- **MCP server / HTTP SDK / A2A endpoint as part of core.** Deferred. The architecture supports these as thin adapters over the same registries. Build when a real consumer exists.

## Consequences

- `Variant.text` stays a string, but its content gains semantic meaning (claim tags). Downstream tooling (operator review UI, ship destination, gates) parses claims out of the text.
- The CI gate distinguishes three failure modes: `unverified` (checked + failed → block), `needs-evidence` (no ref proposed → warn or block per consumer policy), `error` (transient → warn, allow). Policy is configurable per brand-kit.
- Five registries total: `GroundingSource`, `ClaimExtractor`, `Grader`, `Verifier`, `Destination`. One mental model: each stage of the pipeline has a registry; consumers extend each via `register*()`.
- Consumers with very large ref-spaces (e.g. enterprise code-symbol indexes) may need to add caching inside their Verifier. Initial behaviour is no cache; defer until measured.
- CloudCannon round-trip safety for `<claim>` HTML passthrough tags is a known pre-implementation spike — confirm WYSIWYG doesn't strip the tag before shipping verifier code.

## Spike result (2026-05-24)

Empirical round-trip test against a live CloudCannon site backed by GitLab. Three test files exercising HTML passthrough tags, HTML comment markers, and mixed/edge cases (multi-line bodies, adjacent tags). Spike repo + matrix live in a private spike repository.

**Source Editor:** byte-perfect for every marker format and every edge case. The Source Editor is essentially a syntax-highlighted textarea — no markdown AST round-trip — so nothing gets transformed.

**Content Editor (the WYSIWYG content team would default to):**

- `<claim ref="...">text</claim>` HTML passthrough — **tag preserved, surrounding paragraph reformatted.** Attributes, inner prose, and close tags survive character-for-character; but the tag gets pulled out of its host paragraph onto its own block-level line, `&nbsp;` entities get injected as paragraph separators, and the tag is rendered as an opaque "`<claim>` cannot be edited / Unexpected element" pill in the editor view.
- `<!-- claim ref="..." -->text<!-- /claim -->` HTML comments — **silently stripped on save.** This is CommonMark renderer behaviour, not a CloudCannon quirk; every markdown processor downstream would do the same.

**Visual Editor:** out of scope (requires per-region `_editables` configuration).

**Decisions locked by the spike:**

1. **HTML passthrough is the canonical marker format.** The "use HTML comments as a fallback" alternative is dropped — empirically catastrophic.
2. **For files containing `<claim>` tags, authors use the Source Editor** until CloudCannon is configured to recognise `<claim>` as a known editable. The dispatcher regex tolerates either inline or block-level placement of the tag, so even Content-Editor-reformatted files verify correctly — the UX is degraded but the verification pipeline is unaffected.
3. **CloudCannon `cloudcannon.config.yml` configuration is a follow-up task,** not blocking the architecture. The goal: register `<claim>` (likely via `_editables` or a custom snippet) so the Content Editor stops treating it as "Unexpected element" and stops reformatting the surrounding paragraph.

## NotebookLM verifier evolution (2026-05-24)

The initial `notebooklm-claim` verifier shipped with a deliberately weak verdict: citations-present → `verified`. The follow-up LLM-as-judge step is now implemented as an opt-in `judge` config on `NotebookLMVerifierConfig`:

```ts
createNotebookLMVerifier({
  judge: createDefaultJudge('anthropic/claude-3-5-sonnet-latest'),
})
```

With a judge configured the verdict logic becomes:

- citations + judge says `supports`     → `verified` (rationale + citations in `supporting`)
- citations + judge says `contradicts`  → `unverified` (reason names the contradiction)
- citations + judge says `inconclusive` → `unverified` (reason: citations exist but don't address the claim)
- no citations (unchanged)              → `unverified`
- judge throws                          → `error`

This catches the failure mode the weak verifier couldn't see: a claim that has citations but is *contradicted* by them. The judge step is opt-in because it adds an extra LLM call (cost + latency) per claim — for low-stakes checks the weak verifier is enough; for publication gates, configure the judge.
