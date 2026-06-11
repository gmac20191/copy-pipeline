# CloudCannon configuration recipe for `<claim>` tags

How to configure CloudCannon's Content Editor so the `<claim ref="prefix:body">text</claim>` HTML-passthrough tags survive a save round-trip cleanly — without the "Unexpected element" placeholder rendering or the surrounding paragraph reformatting.

**Status**: this recipe is built from the CloudCannon developer reference (`_editables.content`) and an empirical round-trip spike (2026-05-24, private spike repo). The minimum-viable fix below is **untested in production** — the spike repo is set up to validate it, and that validation step is recommended before rolling out to a content team. See "Verify before rolling out" at the bottom.

## What we're fixing

The spike confirmed that CloudCannon's Content Editor:

- ✓ **Preserves** the `<claim>` tag itself byte-perfect (attributes intact, inner prose intact, close tag intact)
- ✗ Renders it as an opaque "`<claim>` cannot be edited / Unexpected element" placeholder pill in the editor view — authors can't see the claim text or edit the prose inside
- ✗ Reformats the surrounding paragraph: pulls the tag out onto its own line, injects `&nbsp;` paragraph separators, strips trailing newline

The verification pipeline still works on the reformatted output (the dispatcher tolerates inline vs block placement), but the UX is degraded.

## Minimum-viable fix

Add to `cloudcannon.config.yml` at the consumer site's repo root:

```yaml
_editables:
  content:
    # Tell the Content Editor that custom HTML markup it doesn't recognise
    # natively should be passed through on save rather than rewritten.
    # CloudCannon's docs warn this "accepts risk of unintended element
    # deletion" — i.e. it's permissive, not bulletproof.
    allow_custom_markup: true
    remove_custom_markup: false
```

Per the CloudCannon developer reference (`_editables.content` keys):

> **`allow_custom_markup`** — Enables editing of custom markup in rich text, accepting risk of unintended element deletion.
>
> **`remove_custom_markup`** — Enables stripping custom markup from edited content.

These flags are the editor-wide allowlist switch. With both flags set this way, the Content Editor should preserve `<claim>` tags on save instead of treating them as foreign elements to strip or reformat aggressively.

## Stronger path: register `<claim>` as a known snippet

CloudCannon also supports `_snippets` — a per-element registration that lets the Content Editor render a custom HTML element as a first-class inline component with editable inner content. This is the better long-term answer because:

- It bypasses the "Unexpected element" placeholder treatment entirely
- The editor knows the element's shape (attributes, inner content) and serialises it back faithfully
- Authors see the claim prose as editable text, not an opaque pill
- The `ref` attribute is preserved without relying on the permissive allow-custom-markup flag

The exact YAML for an inline snippet that accepts an arbitrary `ref` attribute isn't documented in the publicly-visible developer reference excerpts. CloudCannon's `_snippets` is shaped for templating-engine-specific registrations (Hugo shortcodes, Jekyll includes, Liquid tags, MDX components). Mapping an HTML passthrough tag to a snippet is in-spec but the canonical YAML pattern needs to be confirmed in your CloudCannon project's editor preview before rolling out.

When that pattern is confirmed, replace the minimum-viable fix above with the snippet registration. Until then, `allow_custom_markup` is the practical path.

## Verify before rolling out

Don't push this config to a content-team site without testing the round-trip. A spike repo connected to a test CloudCannon site is the way to do it:

```bash
cd <your-spike-repo>   # a throwaway repo connected to a test CloudCannon site
# Add cloudcannon.config.yml with the allow_custom_markup recipe above
# Push to the connected git repo
# In CloudCannon: open content/01-html-passthrough.md in the Content Editor
# Edit one word of prose outside the claim tags. Save.
git pull
bash scripts/check.sh
```

Expected after the fix lands:

- The `<claim>` tag opens/closes count stays at `3 / 3` for `01-html-passthrough.md` (unchanged from the baseline)
- The diff shows only the word change, not the paragraph reformatting
- No `&nbsp;` insertions
- Trailing newline preserved

If the test still shows reformatting, the snippet-based registration is needed and the allow-custom-markup path isn't sufficient on its own. Update the spike README matrix with the empirical result and iterate from there.

## Caveats

- The `embed` config option also enables raw HTML in the Content Editor, but it applies sanitization (removes `style` tags, blocks scripts) intended for media embeds. It's not the right primitive for arbitrary inline tags.
- CloudCannon's underlying rich-text engine has historically been TinyMCE-based; behaviour around custom HTML can change between editor versions. Re-test on major editor upgrades.
- The `allow_custom_markup` flag is editor-wide — it applies to every editable in the Content Editor, not just `<claim>`. If your content team needs other custom HTML kept (or specifically rejected) this is the lever for all of it.
- Authors using the Source Editor (`<>` toolbar icon) are unaffected by any of this — Source Editor is raw text mode and preserves everything byte-perfect regardless of `_editables.content` config (per the spike).

## Cross-references

- ADR `docs/adr/0002-claim-verification.md` — the architecture decision + empirical spike findings
- `docs/AUTHORING.md` — when to author in the Source Editor vs Content Editor
- Spike repo (private) — the preservation matrix
- CloudCannon dev reference: `cloudcannon.com/documentation/developer-reference/configuration-file/types/_editables/` and `.../types/_snippets/`
