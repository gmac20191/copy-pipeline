import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BrandKit } from '../../src/brand-kit.js'
import type { BriefEvent } from '../../src/source/index.js'
import {
  createGoogleDriveSource,
  _parseGoogleDriveConfig,
  _fileToBriefEvent,
  type DriveClient,
} from '../../src/source/google-drive.js'

function brandKit(): BrandKit {
  return {
    name: 'test',
    version: '0.1.0',
    canonicals: { marketing: { spec: 'docs/brand/CANONICAL.md' } },
    corpora: {},
    models: { candidates: ['x/y'], grader: 'x/y' },
  }
}

interface FakeFile {
  id: string
  name: string
  mimeType: string
  content: string
  modifiedTime?: string
  ownerEmail?: string
}

function fakeClient(args: {
  files: FakeFile[]
  onContentRead?: (id: string) => void
}): DriveClient {
  return {
    async listFolder() {
      return args.files.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime ?? null,
        owners: f.ownerEmail ? [{ emailAddress: f.ownerEmail }] : null,
      }))
    },
    async fetchContent(req) {
      args.onContentRead?.(req.fileId)
      const f = args.files.find((x) => x.id === req.fileId)
      if (!f) throw new Error(`fake-client: no file ${req.fileId}`)
      return f.content
    },
  }
}

let statePath: string

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gdrive-test-'))
  statePath = join(dir, 'state.json')
})
afterEach(() => {})

const baseConfig = (): Record<string, unknown> => ({
  watch_folder_id: 'folder-1',
  auth: { service_account_key_path: '/unused/path.json' },
  state_path: statePath,
  poll_interval_seconds: 60,
})

// ─── Config schema ────────────────────────────────────────────────────────

describe('configSchema', () => {
  it('parses a minimal valid config + applies defaults', () => {
    const parsed = _parseGoogleDriveConfig({
      watch_folder_id: 'f',
      auth: { service_account_key_path: '/x' },
    })
    expect(parsed.poll_interval_seconds).toBe(30)
    expect(parsed.brief_template).toMatch(/brand canonical/i)
    expect(parsed.supported_mime_types).toContain(
      'application/vnd.google-apps.document',
    )
    expect(parsed.recursive).toBe(false)
  })

  it('rejects a config without watch_folder_id', () => {
    expect(() =>
      _parseGoogleDriveConfig({
        auth: { service_account_key_path: '/x' },
      }),
    ).toThrow()
  })

  it('rejects a config with no auth method', () => {
    expect(() =>
      _parseGoogleDriveConfig({
        watch_folder_id: 'f',
        auth: {},
      }),
    ).toThrow(/service_account_key_path or oauth_token_path/)
  })

  it('accepts oauth-only auth', () => {
    const parsed = _parseGoogleDriveConfig({
      watch_folder_id: 'f',
      auth: { oauth_token_path: '/tok' },
    })
    expect(parsed.auth.oauth_token_path).toBe('/tok')
  })
})

// ─── File-to-BriefEvent mapping ──────────────────────────────────────────

describe('fileToBriefEvent', () => {
  it('maps a Google Doc into a BriefEvent with metadata', () => {
    const parsed = _parseGoogleDriveConfig({
      watch_folder_id: 'f',
      auth: { service_account_key_path: '/x' },
    })
    const event = _fileToBriefEvent(
      {
        id: 'doc-1',
        name: 'My Draft.gdoc',
        mimeType: 'application/vnd.google-apps.document',
        modifiedTime: '2026-05-25T10:00:00Z',
        owners: [{ emailAddress: 'reviewer@example.com' }],
      },
      parsed,
      'document body content',
    )
    expect(event.id).toBe('doc-1')
    expect(event.brief.text).toBe(parsed.brief_template)
    expect(event.sourceDocument).toBe('document body content')
    expect(event.metadata['sourcePath']).toBe('My Draft.gdoc')
    expect(event.metadata['mimeType']).toBe(
      'application/vnd.google-apps.document',
    )
    expect(event.metadata['modifiedAt']).toBe('2026-05-25T10:00:00Z')
    expect(event.metadata['author']).toBe('reviewer@example.com')
  })

  it('handles a missing-owners file without crashing', () => {
    const parsed = _parseGoogleDriveConfig({
      watch_folder_id: 'f',
      auth: { service_account_key_path: '/x' },
    })
    const event = _fileToBriefEvent(
      {
        id: 'doc-2',
        name: 'no-owner.md',
        mimeType: 'text/markdown',
      },
      parsed,
      '# body',
    )
    expect(event.metadata['author']).toBeUndefined()
  })
})

// ─── End-to-end watch loop with stubbed Drive client ──────────────────────

describe('watch()', () => {
  it('yields one BriefEvent per new file + skips already-processed ids', async () => {
    const files: FakeFile[] = [
      {
        id: 'doc-1',
        name: 'Doc 1',
        mimeType: 'application/vnd.google-apps.document',
        content: 'body of doc 1',
      },
      {
        id: 'doc-2',
        name: 'Doc 2',
        mimeType: 'text/markdown',
        content: '# body of doc 2',
      },
    ]

    const source = createGoogleDriveSource({
      driveClientFactory: async () => fakeClient({ files }),
      sleep: async () => undefined, // immediate
    })

    const collected: BriefEvent[] = []
    const iter = source.watch({
      config: baseConfig(),
      ctx: { workspaceRoot: '/tmp', brandKit: brandKit() },
    })
    for await (const e of iter) {
      collected.push(e)
      if (collected.length >= 2) break // stop after first poll yields all
    }

    expect(collected).toHaveLength(2)
    expect(collected.map((e) => e.id)).toEqual(['doc-1', 'doc-2'])
    expect(collected[0]?.sourceDocument).toBe('body of doc 1')

    // State file persisted
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    expect(state.processed_ids).toEqual(['doc-1', 'doc-2'])
    expect(state.last_polled_at).toBeTruthy()
  })

  it('respects persisted state on restart — does not re-fetch known ids', async () => {
    const files: FakeFile[] = [
      {
        id: 'doc-1',
        name: 'Doc 1',
        mimeType: 'text/markdown',
        content: 'old',
      },
      {
        id: 'doc-2',
        name: 'Doc 2',
        mimeType: 'text/markdown',
        content: 'new',
      },
    ]
    // Pre-seed state with doc-1 processed
    const { writeFile: wf, mkdir } = await import('node:fs/promises')
    await mkdir(join(statePath, '..'), { recursive: true })
    await wf(statePath, JSON.stringify({ processed_ids: ['doc-1'] }, null, 2))

    const reads: string[] = []
    const source = createGoogleDriveSource({
      driveClientFactory: async () =>
        fakeClient({
          files,
          onContentRead: (id) => reads.push(id),
        }),
      sleep: async () => undefined,
    })

    const collected: BriefEvent[] = []
    const iter = source.watch({
      config: baseConfig(),
      ctx: { workspaceRoot: '/tmp', brandKit: brandKit() },
    })
    for await (const e of iter) {
      collected.push(e)
      if (collected.length >= 1) break
    }

    expect(collected.map((e) => e.id)).toEqual(['doc-2'])
    expect(reads).toEqual(['doc-2']) // doc-1 never read
  })
})

// ─── fetchOne() ──────────────────────────────────────────────────────────

describe('fetchOne()', () => {
  it('returns a BriefEvent for a known id', async () => {
    const source = createGoogleDriveSource({
      driveClientFactory: async () =>
        fakeClient({
          files: [
            {
              id: 'doc-x',
              name: 'X',
              mimeType: 'text/plain',
              content: 'x body',
            },
          ],
        }),
    })
    const event = await source.fetchOne!({
      id: 'doc-x',
      config: baseConfig(),
      ctx: { workspaceRoot: '/tmp', brandKit: brandKit() },
    })
    expect(event.id).toBe('doc-x')
    expect(event.sourceDocument).toBe('x body')
  })

  it('throws when the file id is not in the watch folder', async () => {
    const source = createGoogleDriveSource({
      driveClientFactory: async () => fakeClient({ files: [] }),
    })
    await expect(
      source.fetchOne!({
        id: 'ghost',
        config: baseConfig(),
        ctx: { workspaceRoot: '/tmp', brandKit: brandKit() },
      }),
    ).rejects.toThrow(/not found/)
  })
})
