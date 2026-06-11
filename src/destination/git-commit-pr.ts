/**
 * git-commit-pr destination adapter.
 *
 * Writes picked copy to a path inside a local git repo, commits it on a
 * feature branch, and (optionally) pushes + opens a PR via the `gh` CLI.
 *
 * Brand-kit config shape:
 *   {
 *     "adapter": "git-commit-pr",
 *     "config": {
 *       "repo": "/absolute/path/to/repo",
 *       "path": "_drafts/${runId}.md",
 *       "branch_prefix": "copy/",
 *       "commit_subject": "docs(copy): land a new draft",
 *       "open_pr": false,
 *       "draft_pr": true,
 *       "push_remote": "origin",
 *       "base_branch": "main"
 *     }
 *   }
 *
 * Defaults are conservative:
 *   - `open_pr` defaults to `false` (commits locally; no push, no PR).
 *   - `draft_pr` defaults to `true` (when `open_pr=true`, opens a draft).
 *   - `push_remote` defaults to `"origin"`.
 *   - `base_branch` defaults to `"main"`.
 *
 * The feature branch name is `${branch_prefix}${slug}-${unix_seconds}`
 * where `slug` is a sanitised projection of the commit subject. Branch
 * uniqueness is guaranteed by the timestamp suffix.
 *
 * Pre-flight checks (all return `ok: false` on failure rather than
 * throwing — keeps the CLI predictable):
 *   - `config.repo` exists and is a git working tree
 *   - Working tree is clean (no uncommitted modifications outside the
 *     destination path) UNLESS `allow_dirty: true` is set
 *   - `gh` is available when `open_pr: true`
 *
 * Conflict handling: if the destination file already exists, it is
 * overwritten on the feature branch. The pre-flight clean check ensures
 * we don't clobber unrelated dirty state on disk.
 */

import { mkdir, writeFile, access } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'

import type { DestinationAdapter, ShipResult, PublishArgs } from './index.js'

const configSchema = z.object({
  repo: z.string().min(1, 'config.repo must be a non-empty absolute path'),
  path: z.string().min(1, 'config.path must be a non-empty path'),
  branch_prefix: z.string().default('copy/'),
  commit_subject: z.string().default('docs(copy): land a new draft'),
  open_pr: z.boolean().default(false),
  draft_pr: z.boolean().default(true),
  push_remote: z.string().default('origin'),
  base_branch: z.string().default('main'),
  allow_dirty: z.boolean().default(false),
  pr_title: z.string().optional(),
  pr_body: z.string().optional(),
})

type Config = z.infer<typeof configSchema>

export const gitCommitPrDestination: DestinationAdapter = {
  name: 'git-commit-pr',
  description:
    'Write copy to a path in a local git repo, commit on a feature branch, optionally push + open a PR via gh.',

  async publish({
    copy,
    targetName,
    config,
  }: PublishArgs): Promise<ShipResult> {
    const parsed = configSchema.safeParse(config)
    if (!parsed.success) {
      return {
        ok: false,
        destinationName: targetName,
        adapterName: 'git-commit-pr',
        error: `invalid config for destination "${targetName}": ${parsed.error.message}`,
      }
    }

    const cfg = parsed.data

    if (!isAbsolute(cfg.repo)) {
      return fail(
        targetName,
        `config.repo must be an absolute path, got "${cfg.repo}"`,
      )
    }

    try {
      await access(cfg.repo)
    } catch {
      return fail(targetName, `config.repo does not exist: ${cfg.repo}`)
    }

    const isRepo = await runGit(cfg.repo, [
      'rev-parse',
      '--is-inside-work-tree',
    ])
    if (!isRepo.ok || isRepo.stdout.trim() !== 'true') {
      return fail(
        targetName,
        `config.repo is not a git working tree: ${cfg.repo}`,
      )
    }

    if (!cfg.allow_dirty) {
      const status = await runGit(cfg.repo, ['status', '--porcelain'])
      if (status.ok && status.stdout.trim().length > 0) {
        return fail(
          targetName,
          `working tree at ${cfg.repo} is dirty. Commit / stash first, or set config.allow_dirty=true to bypass.`,
        )
      }
    }

    if (cfg.open_pr) {
      const ghCheck = await run('gh', ['--version'])
      if (!ghCheck.ok) {
        return fail(
          targetName,
          'config.open_pr=true but `gh` CLI is not on PATH. Install it or set open_pr=false to commit locally only.',
        )
      }
    }

    const branchName = makeBranchName(cfg)

    const checkout = await runGit(cfg.repo, ['checkout', '-b', branchName])
    if (!checkout.ok) {
      return fail(
        targetName,
        `failed to create branch ${branchName}: ${checkout.stderr}`,
      )
    }

    const fileRelPath = cfg.path
    const fileAbsPath = resolve(cfg.repo, fileRelPath)

    try {
      await mkdir(dirname(fileAbsPath), { recursive: true })
      await writeFile(fileAbsPath, copy, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return fail(targetName, `failed to write ${fileAbsPath}: ${msg}`)
    }

    const add = await runGit(cfg.repo, ['add', fileRelPath])
    if (!add.ok) {
      return fail(targetName, `git add failed: ${add.stderr}`)
    }

    const commit = await runGit(cfg.repo, ['commit', '-m', cfg.commit_subject])
    if (!commit.ok) {
      return fail(targetName, `git commit failed: ${commit.stderr}`)
    }

    let prUrl: string | undefined

    if (cfg.open_pr) {
      const push = await runGit(cfg.repo, [
        'push',
        '-u',
        cfg.push_remote,
        branchName,
      ])
      if (!push.ok) {
        return fail(
          targetName,
          `git push to ${cfg.push_remote} failed: ${push.stderr}`,
        )
      }

      const prArgs = [
        'pr',
        'create',
        '--base',
        cfg.base_branch,
        '--head',
        branchName,
        '--title',
        cfg.pr_title ?? cfg.commit_subject,
        '--body',
        cfg.pr_body ?? cfg.commit_subject,
      ]
      if (cfg.draft_pr) prArgs.push('--draft')

      const pr = await runIn(cfg.repo, 'gh', prArgs)
      if (!pr.ok) {
        return fail(targetName, `gh pr create failed: ${pr.stderr}`)
      }
      prUrl = pr.stdout.trim()
    }

    return {
      ok: true,
      destinationName: targetName,
      adapterName: 'git-commit-pr',
      detail: `committed ${copy.length} chars to ${branchName}${
        cfg.open_pr ? ' and opened PR' : ' (local only)'
      } at ${join(cfg.repo, fileRelPath)}`,
      url: prUrl ?? `file://${fileAbsPath}`,
    }
  },
}

function makeBranchName(cfg: Config): string {
  const slug = cfg.commit_subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const stamp = Math.floor(Date.now() / 1000)
  return `${cfg.branch_prefix}${slug || 'copy'}-${stamp}`
}

function fail(targetName: string, error: string): ShipResult {
  return {
    ok: false,
    destinationName: targetName,
    adapterName: 'git-commit-pr',
    error,
  }
}

interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
}

function run(cmd: string, args: string[]): Promise<RunResult> {
  return runIn(undefined, cmd, args)
}

function runGit(cwd: string, args: string[]): Promise<RunResult> {
  return runIn(cwd, 'git', args)
}

function runIn(
  cwd: string | undefined,
  cmd: string,
  args: string[],
): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (b) => (stdout += b.toString()))
    proc.stderr.on('data', (b) => (stderr += b.toString()))
    proc.on('error', (err) => {
      resolveRun({ ok: false, stdout, stderr: err.message })
    })
    proc.on('close', (code) => {
      resolveRun({ ok: code === 0, stdout, stderr })
    })
  })
}
