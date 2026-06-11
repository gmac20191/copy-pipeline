# Authoring tagged content for copy-pipeline

How to write content with `<claim ref="...">` tags so the verification pipeline holds together and your CMS doesn't destroy your markers.

This is the brand-agnostic authoring guide. Project-specific conventions (which evidence prefixes are available, which corpora are wired) live in each consumer project.

## TL;DR

For files containing `<claim>` tags:

- **Author in a CMS's Source Editor** (or the raw-markdown view your tool offers), not the WYSIWYG Content Editor.
- If your team has to use a WYSIWYG, configure the editor to recognise `<claim>` as a known element (CloudCannon: `_editables` / custom snippets; other CMSs: per-vendor).
- The claim tag itself, attributes included, will survive most editors. The surrounding paragraph structure may not.

## The empirical findings

A round-trip spike against CloudCannon's three editor modes (a private round-trip spike repo) characterised the editor behaviour:

| Editor mode | `<claim ref="...">text</claim>` | `<!-- claim ref="..." -->text<!-- /claim -->` |
|---|---|---|
| **Source Editor** (raw markdown) | byte-perfect | byte-perfect |
| **Content Editor** (WYSIWYG) | tag preserved, surrounding paragraph reformatted (inline→block, `&nbsp;` injection); shown as opaque "cannot be edited / Unexpected element" pill | **silently stripped on save** (fatal) |
| **Visual Editor** | not tested (requires per-region `_editables` config) | not tested |

The same shape holds for most markdown-aware CMSs: HTML comments are stripped by the CommonMark renderer, raw HTML elements survive but the editor often refuses to let users touch them.

This is why the canonical marker format is HTML passthrough tags, not HTML comments. See ADR `docs/adr/0002-claim-verification.md`.

## What this means for authors

### If you author in raw markdown (best)

Files containing `<claim>` tags belong in the Source Editor (or your CMS's equivalent "code view"). Examples:

- CloudCannon: Source Editor (`<>` icon in the toolbar)
- Mintlify: code mode
- Plain git workflow: just edit the markdown file in your editor of choice
- Other CMSs: look for "raw view" / "markdown view" / "code mode"

Authoring this way is byte-perfect across saves. The tag stays where you wrote it. Surrounding prose is unaffected.

### If your team uses a WYSIWYG

Two failure modes to be aware of:

1. **Tag rendered as an opaque placeholder.** Your authors won't see the claim text — they'll see something like "`<claim>` cannot be edited / Unexpected element". The text is still in the markdown, but the WYSIWYG hides it. Authors can't iterate on the prose inside the tag.

2. **Surrounding paragraph reformatted.** The tag gets pulled out of its host paragraph onto its own block-level line, with `&nbsp;` paragraph separators injected. The downstream verifier still works (the dispatcher regex tolerates inline or block placement), but the published page will visibly change — more paragraph breaks, occasional non-breaking-space glyphs.

The fix is to teach the WYSIWYG that `<claim>` is intentional. CloudCannon-specific:

- Add an `_editables` config or custom snippet definition in `cloudcannon.config.yml`.
- See CloudCannon docs on snippets + structured editing.
- Once configured, the editor stops the "unexpected element" treatment and stops reformatting around the tag.

For other CMSs, the equivalent mechanism is usually a custom-tag allowlist or a custom React/Web Component registration.

## Recommended workflow

1. Operator (or a copy-pipeline run) drafts content with `<claim>` tags wrapped around product-behaviour assertions and science assertions.
2. Run `copy-pipeline verify <file>` (see CLI docs) to confirm every tagged claim resolves to a verified or `needs-evidence` verdict — never `unverified` for published content unless intentional.
3. Land the tagged file in the source repo via git.
4. If the consuming site has CMS-driven editing, brief the team on Source-Editor authoring or ship the WYSIWYG config that recognises `<claim>`.

## Open follow-ups

- A CloudCannon `_editables` recipe that registers `<claim>` as a styled inline component. Once landed, content teams can use the Content Editor without the placeholder / reformatting issues.
- Equivalent recipes for other common CMSs (Mintlify, Notion-backed publishers, etc.).
- Reader-facing receipts — a build-time transform that turns `<claim ref="...">text</claim>` into a styled span with a tooltip / footnote showing the citation. First implemented in a consuming site's build pipeline.
