# Smoketest brand canonical

This file exists so the smoketest fixture's `brand-kit.json` can point at it. It is a placeholder canonical for the copy-pipeline-watch smoke test — not a real brand voice spec.

The operational rules live next door in `rules.json`. They lint for generic first-draft hygiene issues (filler words, vague nouns, empty marketing phrases) so we can verify the `brand-review` grader bites and the rewritten variant cleans them up.

A real consumer would replace this file with a written voice/positioning spec and tighten `rules.json` to enforce its specific banned phrases.
