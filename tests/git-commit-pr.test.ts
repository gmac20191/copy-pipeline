import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it, beforeEach } from 'vitest'

import { gitCommitPrDestination } from '../src/destination/git-commit-pr.js'

/**
 * Helper: spawn a process and resolve with stdout/stderr/exitCode.
 */
function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const proc = spawn(cmd, args, { cwd, env: { ...process.env } })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (b) => (stdout += b.toString()))
    proc.stderr.on('data', (b) => (stderr += b.toString()))
    proc.on('error', (err) =>
      resolveRun({ ok: false, stdout, stderr: err.message }),
    )
    proc.on('close', (code) => resolveRun({ ok: code === 0, stdout, stderr }))
  })
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'git-commit-pr-test-'))
  await run('git', ['init', '--initial-branch=main'], dir)
  await run('git', ['config', 'user.email', 'test@example.com'], dir)
  await run('git', ['config', 'user.name', 'Test'], dir)
  await run('git', ['config', 'commit.gpgsign', 'false'], dir)
  // Need at least one commit on main so feature branches have a base.
  await writeFile(join(dir, 'README.md'), 'seed\n', 'utf-8')
  await run('git', ['add', 'README.md'], dir)
  await run('git', ['commit', '-m', 'seed'], dir)
  return dir
}

describe('git-commit-pr destination adapter', () => {
  let repo: string

  beforeEach(async () => {
    repo = await makeRepo()
  })

  it('writes + commits to a feature branch (open_pr=false, default)', async () => {
    const result = await gitCommitPrDestination.publish({
      copy: '# Draft\n\nHello world.\n',
      targetName: 'scratch',
      config: {
        repo,
        path: '_drafts/hello.md',
        commit_subject: 'docs(copy): land hello draft',
      },
    })

    expect(result.ok).toBe(true)
    expect(result.adapterName).toBe('git-commit-pr')
    expect(result.destinationName).toBe('scratch')
    expect(result.detail).toMatch(/local only/)

    // Verify the file actually landed at HEAD on the feature branch.
    const written = await readFile(join(repo, '_drafts/hello.md'), 'utf-8')
    expect(written).toBe('# Draft\n\nHello world.\n')

    // Verify HEAD is on the feature branch, not main.
    const branchResult = await run(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      repo,
    )
    expect(branchResult.ok).toBe(true)
    expect(branchResult.stdout.trim()).toMatch(
      /^copy\/docs-copy-land-hello-draft-\d+$/,
    )

    // Verify the commit subject is on HEAD.
    const log = await run('git', ['log', '-1', '--format=%s'], repo)
    expect(log.stdout.trim()).toBe('docs(copy): land hello draft')
  })

  it('rejects an invalid config (no repo path)', async () => {
    const result = await gitCommitPrDestination.publish({
      copy: 'x',
      targetName: 'bad',
      config: { path: 'x.md' },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/invalid config/)
  })

  it('rejects a relative repo path', async () => {
    const result = await gitCommitPrDestination.publish({
      copy: 'x',
      targetName: 'rel',
      config: { repo: './somewhere', path: 'x.md' },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/absolute path/)
  })

  it("rejects when repo isn't a git working tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'not-a-repo-'))
    const result = await gitCommitPrDestination.publish({
      copy: 'x',
      targetName: 'nope',
      config: { repo: dir, path: 'x.md' },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not a git working tree/)
  })

  it('refuses a dirty working tree by default', async () => {
    // Leave an unstaged change.
    await writeFile(join(repo, 'README.md'), 'dirty\n', 'utf-8')

    const result = await gitCommitPrDestination.publish({
      copy: 'x',
      targetName: 'dirty',
      config: { repo, path: '_drafts/x.md' },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/working tree.*dirty/)
  })

  it('allow_dirty=true bypasses the cleanliness check', async () => {
    await writeFile(join(repo, 'README.md'), 'dirty\n', 'utf-8')

    const result = await gitCommitPrDestination.publish({
      copy: 'ok\n',
      targetName: 'dirty-allowed',
      config: {
        repo,
        path: '_drafts/x.md',
        allow_dirty: true,
      },
    })

    expect(result.ok).toBe(true)
    // Verify only the intended file is in the new commit (not README).
    const show = await run('git', ['show', '--stat', 'HEAD'], repo)
    expect(show.stdout).toMatch(/_drafts\/x\.md/)
    expect(show.stdout).not.toMatch(/README\.md/)
  })

  it('creates intermediate directories for nested paths', async () => {
    const result = await gitCommitPrDestination.publish({
      copy: 'nested\n',
      targetName: 'nested',
      config: {
        repo,
        path: 'deep/nested/dir/output.md',
        commit_subject: 'docs(copy): nested',
      },
    })

    expect(result.ok).toBe(true)
    await access(join(repo, 'deep/nested/dir/output.md'))
  })

  it('returns ok=false with a specific error when open_pr=true and gh is absent', async () => {
    // Skip if `gh` IS on PATH in the test environment — the test would
    // accidentally try to push to a real remote.
    const ghCheck = await run('gh', ['--version'])
    if (ghCheck.ok) {
      return
    }

    const result = await gitCommitPrDestination.publish({
      copy: 'x',
      targetName: 'needs-gh',
      config: {
        repo,
        path: '_drafts/x.md',
        open_pr: true,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/gh.*not on PATH|open_pr/)
  })
})
