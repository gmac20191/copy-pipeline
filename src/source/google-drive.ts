/**
 * `google-drive` BriefSource adapter.
 *
 * Watches a Google Drive folder for new documents. Yields one BriefEvent per
 * document, with the doc body fetched as plain text (Google Docs exported to
 * text/plain; raw markdown / plain text passed through). The watch daemon
 * (`copy-pipeline-watch`) drives this; the same adapter is callable
 * one-shot via `fetchOne()` for backfill or manual reprocess.
 *
 * Auth modes:
 *
 *  - Service account (recommended for shared-drive folders + automation).
 *    The shared drive must grant the service account at least Viewer access
 *    on the watch folder. Configure via `auth.service_account_key_path`.
 *  - OAuth user flow (token JSON from a prior `gcloud auth` or app-specific
 *    consent flow). Useful when the watch folder is in a personal Drive.
 *    Configure via `auth.oauth_token_path`.
 *
 * Polling-only for now (no webhook subscription) because webhooks require a
 * publicly-reachable callback URL. Polling at ~30s is fine for content-team
 * cadence and stays well inside the Drive API quota.
 *
 * State persistence: processed doc ids land in a JSON state file
 * (`state_path`, default `~/.config/copy-pipeline/<source-name>.state.json`)
 * so daemon restarts don't reprocess the same docs.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { google, type drive_v3 } from 'googleapis'
import { z } from 'zod'

import { expandUser } from '../brand-kit.js'
import type { BriefEvent, BriefSource } from './index.js'

// ─── Config schema ──────────────────────────────────────────────────────────

const authSchema = z
  .object({
    service_account_key_path: z.string().optional(),
    oauth_token_path: z.string().optional(),
  })
  .refine((a) => Boolean(a.service_account_key_path || a.oauth_token_path), {
    message:
      'auth must set either service_account_key_path or oauth_token_path',
  })

const SUPPORTED_MIME_TYPES_DEFAULT = [
  'application/vnd.google-apps.document', // Google Doc
  'text/markdown',
  'text/plain',
]

const configSchema = z.object({
  watch_folder_id: z.string().min(1),
  auth: authSchema,
  poll_interval_seconds: z.number().int().positive().default(30),
  supported_mime_types: z
    .array(z.string())
    .default(SUPPORTED_MIME_TYPES_DEFAULT),
  brief_template: z
    .string()
    .default(
      'Apply the brand canonical to the following document. Improve clarity, voice, and SEO without changing intent. Preserve structure unless a section is clearly broken.',
    ),
  /** Where to persist processed-id state across daemon restarts. */
  state_path: z.string().optional(),
  /** Subfolder filter (recursive search inside watch_folder_id). */
  recursive: z.boolean().default(false),
})

export type GoogleDriveSourceConfig = z.input<typeof configSchema>

// ─── Auth ──────────────────────────────────────────────────────────────────

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

type DriveAuth =
  | InstanceType<typeof google.auth.JWT>
  | InstanceType<typeof google.auth.OAuth2>

async function buildAuthClient(
  parsed: z.infer<typeof configSchema>,
): Promise<DriveAuth> {
  const { auth } = parsed
  if (auth.service_account_key_path) {
    const keyJson = JSON.parse(
      await readFile(expandUser(auth.service_account_key_path), 'utf8'),
    ) as { client_email: string; private_key: string }
    const sa = new google.auth.JWT({
      email: keyJson.client_email,
      key: keyJson.private_key,
      scopes: DRIVE_SCOPES,
    })
    await sa.authorize()
    return sa
  }
  const tokenJson = JSON.parse(
    await readFile(expandUser(auth.oauth_token_path!), 'utf8'),
  )
  const oauth = new google.auth.OAuth2()
  oauth.setCredentials(tokenJson)
  return oauth
}

// ─── State persistence ─────────────────────────────────────────────────────

interface PersistedState {
  processed_ids: string[]
  last_polled_at?: string
}

function defaultStatePath(name: string): string {
  return join(homedir(), '.config', 'copy-pipeline', `${name}.state.json`)
}

async function readState(path: string): Promise<PersistedState> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as PersistedState
    return {
      processed_ids: parsed.processed_ids ?? [],
      ...(parsed.last_polled_at
        ? { last_polled_at: parsed.last_polled_at }
        : {}),
    }
  } catch {
    return { processed_ids: [] }
  }
}

async function writeState(path: string, state: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2), 'utf8')
}

// ─── Drive interactions ───────────────────────────────────────────────────

interface DriveClient {
  listFolder(args: {
    folderId: string
    mimeTypes: string[]
    recursive: boolean
  }): Promise<drive_v3.Schema$File[]>
  fetchContent(args: { fileId: string; mimeType: string }): Promise<string>
}

function buildDriveClient(authClient: DriveAuth): DriveClient {
  const drive = google.drive({ version: 'v3', auth: authClient })

  async function listFolder(args: {
    folderId: string
    mimeTypes: string[]
    recursive: boolean
  }): Promise<drive_v3.Schema$File[]> {
    const mimeQuery = args.mimeTypes.map((m) => `mimeType='${m}'`).join(' or ')
    const q = `'${args.folderId}' in parents and (${mimeQuery}) and trashed = false`
    const all: drive_v3.Schema$File[] = []
    let pageToken: string | undefined
    do {
      const params: drive_v3.Params$Resource$Files$List = {
        q,
        fields:
          'nextPageToken, files(id, name, mimeType, modifiedTime, owners(emailAddress))',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }
      if (pageToken !== undefined) params.pageToken = pageToken
      const res = await drive.files.list(params)
      for (const f of res.data.files ?? []) all.push(f)
      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)

    if (args.recursive) {
      const subfolders = await drive.files.list({
        q: `'${args.folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
      for (const sf of subfolders.data.files ?? []) {
        if (sf.id) {
          const childFiles = await listFolder({
            folderId: sf.id,
            mimeTypes: args.mimeTypes,
            recursive: true,
          })
          all.push(...childFiles)
        }
      }
    }
    return all
  }

  async function fetchContent(args: {
    fileId: string
    mimeType: string
  }): Promise<string> {
    if (args.mimeType === 'application/vnd.google-apps.document') {
      const res = await drive.files.export(
        { fileId: args.fileId, mimeType: 'text/plain' },
        { responseType: 'text' },
      )
      return String(res.data)
    }
    const res = await drive.files.get(
      { fileId: args.fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' },
    )
    return String(res.data)
  }

  return { listFolder, fetchContent }
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export interface GoogleDriveSourceOptions {
  /** Override the Drive client (tests inject a mock). */
  driveClientFactory?: (
    parsed: z.infer<typeof configSchema>,
  ) => Promise<DriveClient>
  /** Override the sleep used between polls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

const defaultDriveClientFactory = async (
  parsed: z.infer<typeof configSchema>,
): Promise<DriveClient> => {
  const auth = await buildAuthClient(parsed)
  return buildDriveClient(auth)
}

function fileToBriefEvent(
  file: drive_v3.Schema$File,
  parsed: z.infer<typeof configSchema>,
  content: string,
): BriefEvent {
  const meta: Record<string, unknown> = {
    sourcePath: file.name ?? '<unnamed>',
    mimeType: file.mimeType ?? 'unknown',
  }
  if (file.modifiedTime) meta['modifiedAt'] = file.modifiedTime
  if (file.owners?.[0]?.emailAddress) {
    meta['author'] = file.owners[0].emailAddress
  }
  return {
    id: file.id ?? '<unknown-id>',
    brief: { text: parsed.brief_template },
    sourceDocument: content,
    metadata: meta,
  }
}

export function createGoogleDriveSource(
  opts: GoogleDriveSourceOptions = {},
): BriefSource {
  const driveClientFactory =
    opts.driveClientFactory ?? defaultDriveClientFactory
  const sleep = opts.sleep ?? defaultSleep

  return {
    name: 'google-drive',
    description:
      'Watches a Google Drive folder for new documents (Google Docs + .md + .txt). Yields one BriefEvent per new file. Polls every poll_interval_seconds; persists processed-id state across restarts.',

    async *watch(args): AsyncIterable<BriefEvent> {
      const parsed = configSchema.parse(args.config)
      const statePath = expandUser(
        parsed.state_path ?? defaultStatePath('google-drive'),
      )
      const client = await driveClientFactory(parsed)
      const state = await readState(statePath)
      const processed = new Set(state.processed_ids)

      // Long-running poll loop. The daemon catches SIGINT and breaks the
      // outer loop; for one-shot consumers (tests) we expose iterations
      // via the AsyncIterable contract — the consumer can break out by
      // not awaiting more.
      while (true) {
        const files = await client.listFolder({
          folderId: parsed.watch_folder_id,
          mimeTypes: parsed.supported_mime_types,
          recursive: parsed.recursive,
        })

        for (const file of files) {
          if (!file.id || processed.has(file.id)) continue
          const content = await client.fetchContent({
            fileId: file.id,
            mimeType: file.mimeType ?? 'text/plain',
          })
          // Persist BEFORE yielding so consumers that break out of the loop
          // immediately after taking an event still leave the state file
          // consistent — otherwise the post-yield writeState never runs.
          processed.add(file.id)
          await writeState(statePath, {
            processed_ids: [...processed],
            last_polled_at: new Date().toISOString(),
          })
          yield fileToBriefEvent(file, parsed, content)
        }

        await sleep(parsed.poll_interval_seconds * 1000)
      }
    },

    async fetchOne(args): Promise<BriefEvent> {
      const parsed = configSchema.parse(args.config)
      const client = await driveClientFactory(parsed)
      // Use a list to get file metadata; we don't have a single-file
      // get-metadata helper exposed. Cheap enough for backfill.
      const files = await client.listFolder({
        folderId: parsed.watch_folder_id,
        mimeTypes: parsed.supported_mime_types,
        recursive: parsed.recursive,
      })
      const file = files.find((f) => f.id === args.id)
      if (!file?.id) {
        throw new Error(
          `google-drive fetchOne: file id '${args.id}' not found in watch folder`,
        )
      }
      const content = await client.fetchContent({
        fileId: file.id,
        mimeType: file.mimeType ?? 'text/plain',
      })
      return fileToBriefEvent(file, parsed, content)
    },
  }
}

export const googleDriveSource: BriefSource = createGoogleDriveSource()

// Re-export the config type so consumers can validate brand-kit entries
// against it without importing from the registry shape.
export type GoogleDriveSourceConfigParsed = z.infer<typeof configSchema>

/** Test helper: parse the config without instantiating the adapter. */
export function _parseGoogleDriveConfig(
  config: unknown,
): z.infer<typeof configSchema> {
  return configSchema.parse(config)
}

/** Test helper: expose the file-to-event mapping. */
export function _fileToBriefEvent(
  file: drive_v3.Schema$File,
  parsed: z.infer<typeof configSchema>,
  content: string,
): BriefEvent {
  return fileToBriefEvent(file, parsed, content)
}

/** Test helper: expose state file IO so tests can verify persistence. */
export const _state = { readState, writeState, defaultStatePath }

// Used in DriveClient interface; re-exported for test injection.
export type { DriveClient }
