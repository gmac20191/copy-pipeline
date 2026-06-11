import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createGoogleDriveDestination,
  _parseGoogleDriveDestinationConfig,
  _resolveFilename,
  type DriveUploadClient,
} from '../../src/destination/google-drive.js'

function fakeClient(overrides?: {
  onCreate?: (args: {
    name: string
    parents: string[]
    mimeType: string
    body: string
    convertToGoogleDoc: boolean
  }) => void
  result?: { id: string; name: string; webViewLink?: string }
  throwOn?: 'createFile' | 'getFolder' | 'getFileModification'
  folder?: { id: string; name: string; driveId?: string; mimeType?: string }
  modification?: {
    modifiedTime?: string
    lastModifyingUser?: string
    notFound?: boolean
  }
}): DriveUploadClient {
  return {
    async createFile(args) {
      overrides?.onCreate?.(args)
      if (overrides?.throwOn === 'createFile') {
        throw new Error('boom — simulated drive failure')
      }
      return (
        overrides?.result ?? {
          id: 'created-id-1',
          name: args.name,
          webViewLink: `https://drive.example/${args.name}`,
        }
      )
    },
    async getFolder(args) {
      if (overrides?.throwOn === 'getFolder') {
        throw new Error('boom — simulated folder lookup failure')
      }
      const f = overrides?.folder ?? {
        id: args.fileId,
        name: 'shared-drive-folder',
        driveId: 'shared-drive-1',
        mimeType: 'application/vnd.google-apps.folder',
      }
      return {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType ?? 'application/vnd.google-apps.folder',
        ...(f.driveId !== undefined ? { driveId: f.driveId } : {}),
      }
    },
    async getFileModification() {
      if (overrides?.throwOn === 'getFileModification') {
        throw new Error('boom — simulated metadata read failure')
      }
      return overrides?.modification ?? {}
    },
  }
}

const baseConfig = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  destination_folder_id: 'dst-folder-1',
  auth: { service_account_key_path: '/unused/path.json' },
  ...over,
})

// ─── Config schema ──────────────────────────────────────────────────────────

describe('configSchema', () => {
  it('parses a minimal valid config + applies defaults', () => {
    const parsed = _parseGoogleDriveDestinationConfig(baseConfig())
    expect(parsed.format).toBe('google_doc')
    expect(parsed.filename).toBe('reviewed-{{timestamp}}.md')
  })

  it('rejects a config without destination_folder_id', () => {
    expect(() =>
      _parseGoogleDriveDestinationConfig({
        auth: { service_account_key_path: '/x' },
      }),
    ).toThrow()
  })

  it('rejects a config with no auth method', () => {
    expect(() =>
      _parseGoogleDriveDestinationConfig({
        destination_folder_id: 'f',
        auth: {},
      }),
    ).toThrow(/service_account_key_path or oauth_token_path/)
  })

  it('rejects an unknown format', () => {
    expect(() =>
      _parseGoogleDriveDestinationConfig(baseConfig({ format: 'pdf' })),
    ).toThrow()
  })
})

// ─── Filename templating ────────────────────────────────────────────────────

describe('resolveFilename', () => {
  const at = new Date('2026-05-25T08:30:00.000Z')

  it('substitutes {{timestamp}} into the template', () => {
    expect(_resolveFilename('reviewed-{{timestamp}}.md', 'markdown', at)).toBe(
      'reviewed-2026-05-25T08-30-00.md',
    )
  })

  it('strips a trailing .md when format is google_doc', () => {
    expect(
      _resolveFilename('reviewed-{{timestamp}}.md', 'google_doc', at),
    ).toBe('reviewed-2026-05-25T08-30-00')
  })

  it('leaves the .md alone for markdown format', () => {
    expect(_resolveFilename('static-name.md', 'markdown', at)).toBe(
      'static-name.md',
    )
  })

  it('leaves a non-.md filename alone for google_doc', () => {
    expect(_resolveFilename('static-name', 'google_doc', at)).toBe(
      'static-name',
    )
  })

  it('handles multiple {{timestamp}} occurrences', () => {
    expect(
      _resolveFilename('{{timestamp}}-and-{{timestamp}}', 'markdown', at),
    ).toBe('2026-05-25T08-30-00-and-2026-05-25T08-30-00')
  })
})

// ─── publish() — happy path ────────────────────────────────────────────────

describe('publish()', () => {
  const at = new Date('2026-05-25T08:30:00.000Z')

  it('uploads a google_doc with the conversion mime hint', async () => {
    const calls: Array<{
      name: string
      mimeType: string
      convertToGoogleDoc: boolean
      parents: string[]
    }> = []
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          onCreate: ({ name, mimeType, convertToGoogleDoc, parents }) => {
            calls.push({ name, mimeType, convertToGoogleDoc, parents })
          },
        }),
      now: () => at,
    })

    const result = await dst.publish({
      copy: '# hello\n\nbody',
      targetName: 'drive-reviewed',
      config: baseConfig(),
    })

    expect(result.ok).toBe(true)
    expect(result.destinationName).toBe('drive-reviewed')
    expect(result.adapterName).toBe('google-drive')
    expect(result.detail).toContain('13 chars')
    expect(result.detail).toContain('google_doc')
    expect(result.url).toMatch(/^https:\/\/drive\.example\//)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('reviewed-2026-05-25T08-30-00') // .md stripped
    expect(calls[0]?.mimeType).toBe('text/markdown') // upload body is markdown
    expect(calls[0]?.convertToGoogleDoc).toBe(true)
    expect(calls[0]?.parents).toEqual(['dst-folder-1'])
  })

  it('writes a literal .md when format=markdown', async () => {
    const calls: Array<{ name: string; convertToGoogleDoc: boolean }> = []
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          onCreate: ({ name, convertToGoogleDoc }) => {
            calls.push({ name, convertToGoogleDoc })
          },
        }),
      now: () => at,
    })

    const result = await dst.publish({
      copy: 'body',
      targetName: 'drive-md',
      config: baseConfig({ format: 'markdown' }),
    })

    expect(result.ok).toBe(true)
    expect(calls[0]?.name).toBe('reviewed-2026-05-25T08-30-00.md')
    expect(calls[0]?.convertToGoogleDoc).toBe(false)
  })

  it('returns ok=false with the zod error when config is invalid', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () => fakeClient(),
      now: () => at,
    })

    const result = await dst.publish({
      copy: 'body',
      targetName: 'broken',
      config: { auth: {} },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('invalid config')
  })

  it('returns ok=false and surfaces the error message when the upload throws', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () => fakeClient({ throwOn: 'createFile' }),
      now: () => at,
    })

    const result = await dst.publish({
      copy: 'body',
      targetName: 'drive-fail',
      config: baseConfig(),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('omits url when the upload response lacks webViewLink', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({ result: { id: 'x', name: 'x' } }),
      now: () => at,
    })

    const result = await dst.publish({
      copy: 'body',
      targetName: 'no-link',
      config: baseConfig(),
    })

    expect(result.ok).toBe(true)
    expect(result.url).toBeUndefined()
  })
})

// ─── preflight() ─────────────────────────────────────────────────────────────

describe('preflight()', () => {
  it('ok when folder is in a Shared Drive (SA-safe)', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          folder: {
            id: 'dst-folder-1',
            name: 'reviewed',
            driveId: 'shared-drive-99',
            mimeType: 'application/vnd.google-apps.folder',
          },
        }),
    })
    const result = await dst.preflight!({
      targetName: 'drive-reviewed',
      config: baseConfig(),
    })
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('shared-drive-99')
  })

  it('rejects SA + personal-Drive folder with the specific fix message', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          folder: {
            id: 'dst-folder-1',
            name: 'reviewed',
            // driveId omitted -> personal My Drive
            mimeType: 'application/vnd.google-apps.folder',
          },
        }),
    })
    const result = await dst.preflight!({
      targetName: 'drive-reviewed',
      config: baseConfig(),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/personal My Drive/)
    expect(result.error).toMatch(/Shared Drive/)
    expect(result.error).toMatch(/Content manager/)
  })

  it('rejects when destination_folder_id is not actually a folder', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          folder: {
            id: 'dst-folder-1',
            name: 'oops-this-is-a-doc',
            driveId: 'shared-drive-99',
            mimeType: 'application/vnd.google-apps.document',
          },
        }),
    })
    const result = await dst.preflight!({
      targetName: 'drive-reviewed',
      config: baseConfig(),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not a folder/)
  })

  it('allows personal Drive when OAuth user auth is configured', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          folder: {
            id: 'dst-folder-1',
            name: 'personal-reviewed',
            mimeType: 'application/vnd.google-apps.folder',
          },
        }),
    })
    const result = await dst.preflight!({
      targetName: 'drive-reviewed',
      config: {
        destination_folder_id: 'dst-folder-1',
        auth: { oauth_token_path: '/tmp/tok.json' },
      },
    })
    expect(result.ok).toBe(true)
    expect(result.detail).toMatch(/OAuth user mode/)
  })

  it('returns ok=false when config is invalid', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () => fakeClient(),
    })
    const result = await dst.preflight!({
      targetName: 'broken',
      config: { auth: {} },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('invalid config')
  })

  it('returns ok=false when the folder lookup throws', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () => fakeClient({ throwOn: 'getFolder' }),
    })
    const result = await dst.preflight!({
      targetName: 'drive-reviewed',
      config: baseConfig(),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('preflight failed')
  })
})

// ─── detectPick() ────────────────────────────────────────────────────────────

describe('detectPick()', () => {
  const SA_EMAIL = 'sa@example.iam.gserviceaccount.com'
  let saKeyPath: string

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gdrive-pick-'))
    saKeyPath = join(dir, 'sa.json')
    await writeFile(
      saKeyPath,
      JSON.stringify({
        client_email: SA_EMAIL,
        private_key:
          '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
      }),
    )
  })

  const cfgWithKey = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    destination_folder_id: 'dst-1',
    auth: { service_account_key_path: saKeyPath },
    ...over,
  })

  it('reports picked=true when modifiedTime > publishedAt AND modifier is not the SA', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          modification: {
            modifiedTime: '2026-05-25T10:30:00Z',
            lastModifyingUser: 'reviewer@example.com',
          },
        }),
    })
    const result = await dst.detectPick!({
      fileId: 'doc-1',
      config: cfgWithKey(),
      publishedAtIso: '2026-05-25T10:00:00Z',
    })
    expect(result.picked).toBe(true)
    expect(result.modifiedBy).toBe('reviewer@example.com')
    expect(result.modifiedAtIso).toBe('2026-05-25T10:30:00Z')
  })

  it('reports picked=false when last modifier IS the SA (= our own write)', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          modification: {
            modifiedTime: '2026-05-25T10:30:00Z',
            lastModifyingUser: SA_EMAIL,
          },
        }),
    })
    const result = await dst.detectPick!({
      fileId: 'doc-1',
      config: cfgWithKey(),
      publishedAtIso: '2026-05-25T10:00:00Z',
    })
    expect(result.picked).toBe(false)
  })

  it('reports picked=false when modifiedTime is at or before publishedAt', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          modification: {
            modifiedTime: '2026-05-25T10:00:00Z',
            lastModifyingUser: 'reviewer@example.com',
          },
        }),
    })
    const result = await dst.detectPick!({
      fileId: 'doc-1',
      config: cfgWithKey(),
      publishedAtIso: '2026-05-25T10:00:00Z',
    })
    expect(result.picked).toBe(false)
  })

  it('treats missing lastModifyingUser email as a human edit (Drive omits email under privacy settings)', async () => {
    // Real-world: Drive returns displayName + photoLink but NO emailAddress
    // when the user has privacy settings hiding their email. Our adapter
    // surfaces this as `lastModifyingUser: undefined`. The pick logic must
    // treat this as definitely-not-SA (SA writes always include the SA
    // email; missing email is by construction a human user).
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          modification: {
            modifiedTime: '2026-05-25T10:30:00Z',
            // lastModifyingUser undefined: Drive returned no emailAddress.
          },
        }),
    })
    const result = await dst.detectPick!({
      fileId: 'doc-1',
      config: cfgWithKey(),
      publishedAtIso: '2026-05-25T10:00:00Z',
    })
    expect(result.picked).toBe(true)
  })

  it('reports notFound=true when the file is gone', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          modification: { notFound: true },
        }),
    })
    const result = await dst.detectPick!({
      fileId: 'doc-1',
      config: cfgWithKey(),
      publishedAtIso: '2026-05-25T10:00:00Z',
    })
    expect(result.picked).toBe(false)
    expect(result.notFound).toBe(true)
  })

  it('OAuth user mode: any post-publish modification counts as a pick', async () => {
    const dst = createGoogleDriveDestination({
      uploadClientFactory: async () =>
        fakeClient({
          modification: {
            modifiedTime: '2026-05-25T10:30:00Z',
            lastModifyingUser: 'reviewer@example.com',
          },
        }),
    })
    const result = await dst.detectPick!({
      fileId: 'doc-1',
      config: {
        destination_folder_id: 'dst-1',
        auth: { oauth_token_path: '/tmp/tok.json' },
      },
      publishedAtIso: '2026-05-25T10:00:00Z',
    })
    expect(result.picked).toBe(true)
  })
})
