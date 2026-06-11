<!--
PR title must be a conventional commit — it becomes the squash commit on main
and drives the next release version:
  feat(scope): ...   → minor    fix(scope): ...  → patch
  feat!: ...         → major    docs/chore/test: → no release
-->

## What

<!-- One or two sentences: what changes and why. Link the issue if one exists. -->

## How it was verified

<!-- Tests added/updated, or how you exercised the change. `yarn test && yarn typecheck && yarn lint:check && yarn build` should be green. -->

## Checklist

- [ ] PR title is a conventional commit
- [ ] Tests cover the new behaviour
- [ ] Docs updated if behaviour changed (README "What's wired up" / CONTEXT.md / ADR)
