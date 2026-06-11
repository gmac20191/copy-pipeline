# smoketest-drive — copy-pipeline-watch end-to-end fixture

Minimal brand-kit + rules fixture proving the watch daemon round-trips through
Google Drive: dropped doc → transform via the configured candidate model →
graded (brand-review + LLM voice judge) → written back as a Google Doc in
`/reviewed`.

## What this is, what it isn't

This is a **wiring test**, not a real brand canonical. The rules in
`docs/brand/rules.json` lint for generic first-draft prose hygiene (filler
words, vague nouns, empty marketing phrases) so we can see brand-review bite
on a deliberately noisy input and confirm the rewrite cleans them up.

A real consumer replaces:

- `docs/brand/CANONICAL.md` with a written voice spec.
- `docs/brand/rules.json` with project-specific banned phrases / audience
  rules / spelling enforcement.
- The placeholder Drive folder IDs in `docs/brand/brand-kit.json` with their
  own Shared Drive folders.

## Prerequisites

- A Google Cloud project with the Drive API enabled.
- A service account in that project with a JSON key downloaded to
  `~/.config/copy-pipeline/copy-pipeline-watch-sa.json` (or update the path in
  `brand-kit.json`).
- A **Shared Drive** containing three folders: `watch/`, `reviewed/`,
  `needs-attention/`. The service account must be added as a Content manager
  on the Shared Drive (folder-level shares aren't enough; SA needs membership
  to write into a Shared Drive's storage).
- `GOOGLE_GENERATIVE_AI_API_KEY` (Gemini API key) in your shell env.

Service accounts have **no storage quota in personal My Drive** — the watch
daemon's preflight check enforces this. If you point the fixture at a My
Drive folder, the daemon will refuse to start with a specific fix message.

## Running

```bash
cd /path/to/copy-pipeline
yarn dlx tsx bin/copy-pipeline-watch.ts \
  --brand-kit examples/smoketest-drive/docs/brand/brand-kit.json \
  --workspace examples/smoketest-drive
```

The daemon will:

1. Load the brand-kit.
2. Pre-flight every destination (resolves folder metadata, errors loudly if
   the folder is in personal My Drive when auth is service-account).
3. Start polling the `watch/` folder every 15 seconds.

Drop a doc into `watch/` (Google Doc, `.md`, or `.txt`). Within ~30s a Google
Doc with the rewritten copy appears in `reviewed/`, named per the template
configured in `brand-kit.json`. Generation failures land in `needs-attention/`
with an error marker.

## Auto-set CLAUDE_PROJECT_DIR

The daemon sets `CLAUDE_PROJECT_DIR` to the resolved `--workspace` path
before invoking subprocess graders (notably the `brand-review` skill). This
is what lets the grader find this fixture's `rules.json` instead of falling
back to its bundled rules.

If you set `CLAUDE_PROJECT_DIR` yourself, the daemon honors it (won't
override).

## Bootstrap script

The Drive folders + SA were created via `gcloud` + a one-off Node script
calling Drive API. The relevant commands (run once, in a fresh GCP sandbox
project):

```bash
gcloud iam service-accounts create copy-pipeline-watch \
  --display-name="copy-pipeline-watch daemon"

gcloud iam service-accounts keys create \
  ~/.config/copy-pipeline/copy-pipeline-watch-sa.json \
  --iam-account=copy-pipeline-watch@<PROJECT_ID>.iam.gserviceaccount.com
```

Then in the Drive UI: create a Shared Drive, add the SA email as Content
Manager, create `watch/` + `reviewed/` + `needs-attention/` folders inside
it, and paste the folder IDs into `brand-kit.json`.
