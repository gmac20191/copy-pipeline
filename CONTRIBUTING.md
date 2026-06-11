# Contributing to copy-pipeline

Thanks for considering a contribution. This document covers the workflow; architecture context lives in [README.md](./README.md), the domain glossary in [CONTEXT.md](./CONTEXT.md), and the load-bearing decisions in [docs/adr/](./docs/adr/).

## Development setup

Requirements: Node ≥ 20, yarn 1.x.

```bash
git clone https://github.com/gmac20191/copy-pipeline.git
cd copy-pipeline
yarn install          # also installs the git hooks via husky
yarn test             # vitest, no network or keys needed
yarn typecheck        # tsc --noEmit
yarn lint             # eslint --fix
yarn build            # tsc → dist/
```

The test suite runs fully offline — no API keys, no docker. The optional local stack (`yarn stack:up`) brings up pgvector + Langfuse for end-to-end experiments; see the README's "Local stack" section.

## Branching strategy

This repo uses **GitHub Flow**:

- `main` is the only long-lived branch and is always releasable. Every push to `main` runs the release pipeline (see "Versioning & releases" below).
- All work happens on short-lived topic branches cut from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, etc.
- Changes land on `main` exclusively via pull request, **squash-merged** so each PR becomes exactly one conventional commit on `main`.
- There is no `develop`, no release branches, no manual version bumps.

## Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and are enforced locally by commitlint (via the husky `commit-msg` hook):

```
feat(verifier): add jira-ticket verifier        → minor release
fix(grader): handle empty rules file            → patch release
feat!: drop node 18 support                     → major release
docs/chore/test/refactor(...): ...              → no release
```

Because PRs are squash-merged, **the PR title becomes the commit message on `main`** — write PR titles in conventional-commit form too. The squash commit's type is what drives the next version number.

## Pull request checklist

- One logical change per PR; keep them small enough to review in one sitting.
- `yarn typecheck && yarn lint:check && yarn test && yarn build` all green (CI enforces this on node 20 and 22).
- New behaviour comes with tests. The codebase avoids mocks where possible — prefer injectable functions/fixtures (see existing tests for the pattern).
- Code style follows the surrounding code; prettier + eslint run automatically on staged files via the pre-commit hook.
- Update docs when behaviour changes: README's "What's wired up" table, CONTEXT.md for new domain terms, a new ADR in `docs/adr/` for architecturally significant decisions.

## Versioning & releases

Releases are fully automated with [semantic-release](https://semantic-release.gitbook.io/) — never tag or draft a release by hand.

On every push to `main` (i.e. every merged PR), CI runs and then semantic-release:

1. analyses the commits since the last git tag,
2. computes the next [semver](https://semver.org/) version (`fix` → patch, `feat` → minor, `BREAKING CHANGE`/`!` → major),
3. tags the commit and publishes a GitHub Release with generated notes.

**Git tags are the version source of truth.** Nothing is committed back to `main`: the `version` field in `package.json` is informational, and release notes live on the [releases page](https://github.com/gmac20191/copy-pipeline/releases) (CHANGELOG.md is the hand-written pre-release history, frozen at 0.1.0).

Commits of type `docs`, `chore`, `test`, `refactor`, `ci` produce no release — they simply ride along until the next `feat`/`fix`.

The package is not published to npm; consumers install from the git tag (`npm install github:gmac20191/copy-pipeline#vX.Y.Z`).

## Extending the pipeline

The supported extension points are the registries — `Grader`, `GroundingSource`, `Verifier`, `ClaimExtractor`, `DestinationAdapter`. Project-specific plugins belong in *your* repo (see [docs/CONSUMER-ONBOARDING.md](./docs/CONSUMER-ONBOARDING.md) and the plugin-pack template in `docs/consumer-templates/`), not in core. PRs that add new built-in adapters/verifiers are welcome when they're broadly useful and degrade gracefully without their env/keys.

## Reporting bugs & proposing features

Use the issue templates. For security-sensitive reports, please use GitHub's private vulnerability reporting rather than a public issue.
