/**
 * `google-drive` destination adapter.
 *
 * Writes picked copy back into Google Drive, typically into a `/reviewed/`
 * subfolder owned by the content team. Designed to pair with the
 * `google-drive` BriefSource: a doc dropped into the watch folder is
 * generated, graded, and the chosen variant lands back in Drive where
 * the content team reviews it inline.
 *
 * Brand-kit config shape:
 *
 *   {
 *     "adapter": "google-drive",
 *     "config": {
 *       "destination_folder_id": "FOLDER_ID",
 *       "auth": { "service_account_key_path": "/path/to/sa.json" },
 *       "format": "google_doc",
 *       "filename": "reviewed-{{timestamp}}.md"
 *     }
 *   }
 *
 * Formats:
 *
 *  - `google_doc` (default) — uploads the copy as text/markdown and asks
 *    Drive to convert into a native Google Doc. Best for review/edit in
 *    Drive UI. Result is a Doc whose name = `filename` (extension stripped).
 *  - `markdown` — writes the copy as a literal `.md` file. Best when the
 *    downstream consumer expects raw markdown (e.g. a git pipeline).
 *
 * Filename templating:
 *
 *  - `{{timestamp}}` — resolved to an ISO-8601 stamp at publish time.
 *  - Other placeholders (e.g. `{{source_id}}`) are NOT resolved by the
 *    destination — the watch daemon (`copy-pipeline-watch`) pre-resolves
 *    those into the config before calling `publish()`, because per-publish
 *    context (source filename / id) isn't part of the standard PublishArgs.
 *
 * Auth: same modes as the BriefSource (`service_account_key_path` for
 * automation / shared drives; `oauth_token_path` for personal Drives).
 */

import { readFile } from 'node:fs/promises'

import { google, type drive_v3 } from 'googleapis'
import { Readable } from 'node:stream'
import { z } from 'zod'

import { expandUser } from '../brand-kit.js'
import type {
  DestinationAdapter,
  ShipResult,
  PublishArgs,
  PreflightArgs,
  PreflightResult,
  DetectPickArgs,
  DetectPickResult,
} from './index.js'

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

const configSchema = z.object({
  destination_folder_id: z.string().min(1),
  auth: authSchema,
  format: z.enum(['google_doc', 'markdown']).default('google_doc'),
  filename: z.string().default('reviewed-{{timestamp}}.md'),
})

type Config = z.infer<typeof configSchema>

// ─── Auth (mirrors the BriefSource adapter for symmetry) ────────────────────

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive']

type DriveAuth =
  | InstanceType<typeof google.auth.JWT>
  | InstanceType<typeof google.auth.OAuth2>

async function buildAuthClient(cfg: Config): Promise<DriveAuth> {
  if (cfg.auth.service_account_key_path) {
    const keyJson = JSON.parse(
      await readFile(expandUser(cfg.auth.service_account_key_path), 'utf8'),
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
    await readFile(expandUser(cfg.auth.oauth_token_path!), 'utf8'),
  )
  const oauth = new google.auth.OAuth2()
  oauth.setCredentials(tokenJson)
  return oauth
}

// ─── Drive write ────────────────────────────────────────────────────────────

/** Injection point for tests — replace the Drive calls to avoid hitting Drive. */
export interface DriveUploadClient {
  createFile(args: {
    name: string
    parents: string[]
    mimeType: string
    body: string
    convertToGoogleDoc: boolean
  }): Promise<{ id: string; name: string; webViewLink?: string }>
  /** Resolves a folder's name + driveId (the Shared Drive root id). When
   *  driveId is null/undefined the folder lives in personal My Drive and a
   *  service account can't write there (storageQuotaExceeded at write time). */
  getFolder(args: { fileId: string }): Promise<{
    id: string
    name: string
    driveId?: string
    mimeType: string
  }>
  /** Resolves a file's modification metadata for pick detection. Returns
   *  notFound=true on 404 so the daemon can prune the entry from the
   *  publishes sidecar. */
  getFileModification(args: { fileId: string }): Promise<{
    modifiedTime?: string
    lastModifyingUser?: string
    notFound?: boolean
  }>
}

function buildDriveUploadClient(authClient: DriveAuth): DriveUploadClient {
  const drive = google.drive({ version: 'v3', auth: authClient })

  return {
    async createFile(args) {
      const requestBody: drive_v3.Schema$File = {
        name: args.name,
        parents: args.parents,
      }
      // When converting markdown → Google Doc, request the destination
      // mimeType on the metadata; the upload body is still text/markdown.
      if (args.convertToGoogleDoc) {
        requestBody.mimeType = 'application/vnd.google-apps.document'
      }
      const res = await drive.files.create({
        requestBody,
        media: {
          mimeType: args.mimeType,
          body: Readable.from([args.body]),
        },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      })
      const file = res.data
      if (!file.id || !file.name) {
        throw new Error('drive files.create returned no id/name')
      }
      const result: { id: string; name: string; webViewLink?: string } = {
        id: file.id,
        name: file.name,
      }
      if (file.webViewLink) result.webViewLink = file.webViewLink
      return result
    },

    async getFolder(args) {
      const res = await drive.files.get({
        fileId: args.fileId,
        fields: 'id, name, driveId, mimeType',
        supportsAllDrives: true,
      })
      const f = res.data
      if (!f.id || !f.name || !f.mimeType) {
        throw new Error(
          `drive files.get returned incomplete record for ${args.fileId}`,
        )
      }
      const out: {
        id: string
        name: string
        driveId?: string
        mimeType: string
      } = {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
      }
      if (f.driveId) out.driveId = f.driveId
      return out
    },

    async getFileModification(args) {
      try {
        const res = await drive.files.get({
          fileId: args.fileId,
          fields: 'id, modifiedTime, lastModifyingUser(emailAddress)',
          supportsAllDrives: true,
        })
        const f = res.data
        const out: {
          modifiedTime?: string
          lastModifyingUser?: string
          notFound?: boolean
        } = {}
        if (f.modifiedTime) out.modifiedTime = f.modifiedTime
        if (f.lastModifyingUser?.emailAddress) {
          out.lastModifyingUser = f.lastModifyingUser.emailAddress
        }
        return out
      } catch (err: unknown) {
        const code =
          err &&
          typeof err === 'object' &&
          'code' in err &&
          typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : undefined
        if (code === 404) return { notFound: true }
        throw err
      }
    },
  }
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export interface GoogleDriveDestinationOptions {
  /** Override the upload client (tests inject a stub). */
  uploadClientFactory?: (cfg: Config) => Promise<DriveUploadClient>
  /** Override the timestamp source (tests pin to a fixed value). */
  now?: () => Date
}

function resolveFilename(
  template: string,
  format: Config['format'],
  now: Date,
): string {
  const ts = now.toISOString().replaceAll(':', '-').replace(/\..+$/, '')
  let name = template.replaceAll('{{timestamp}}', ts)
  // For Google Doc conversion, strip a trailing .md extension — Drive
  // displays the doc by name and a .md suffix looks broken in the UI.
  if (format === 'google_doc' && name.toLowerCase().endsWith('.md')) {
    name = name.slice(0, -3)
  }
  return name
}

export function createGoogleDriveDestination(
  opts: GoogleDriveDestinationOptions = {},
): DestinationAdapter {
  const uploadClientFactory =
    opts.uploadClientFactory ??
    (async (cfg) => buildDriveUploadClient(await buildAuthClient(cfg)))
  const now = opts.now ?? (() => new Date())

  return {
    name: 'google-drive',
    description:
      'Write picked copy back to a Google Drive folder as a Google Doc (default) or .md file. Pairs with the google-drive BriefSource for end-to-end Drive workflows.',

    async preflight({
      targetName,
      config,
    }: PreflightArgs): Promise<PreflightResult> {
      const parsed = configSchema.safeParse(config)
      if (!parsed.success) {
        return {
          ok: false,
          destinationName: targetName,
          adapterName: 'google-drive',
          error: `invalid config for destination "${targetName}": ${parsed.error.message}`,
        }
      }
      const cfg = parsed.data
      try {
        const client = await uploadClientFactory(cfg)
        const folder = await client.getFolder({
          fileId: cfg.destination_folder_id,
        })
        if (folder.mimeType !== 'application/vnd.google-apps.folder') {
          return {
            ok: false,
            destinationName: targetName,
            adapterName: 'google-drive',
            error: `destination_folder_id ${cfg.destination_folder_id} is not a folder (mime: ${folder.mimeType})`,
          }
        }
        if (cfg.auth.service_account_key_path && !folder.driveId) {
          return {
            ok: false,
            destinationName: targetName,
            adapterName: 'google-drive',
            error: `destination folder "${folder.name}" (${cfg.destination_folder_id}) is in personal My Drive — service accounts have no storage quota there and will 403 at first publish. Move the folder into a Shared Drive and add the SA as a Content manager.`,
          }
        }
        return {
          ok: true,
          destinationName: targetName,
          adapterName: 'google-drive',
          detail: folder.driveId
            ? `folder "${folder.name}" resolved in Shared Drive ${folder.driveId}`
            : `folder "${folder.name}" resolved (OAuth user mode, personal Drive ok)`,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          destinationName: targetName,
          adapterName: 'google-drive',
          error: `preflight failed: ${msg}`,
        }
      }
    },

    async detectPick({
      fileId,
      config,
      publishedAtIso,
    }: DetectPickArgs): Promise<DetectPickResult> {
      const parsed = configSchema.parse(config)
      const client = await uploadClientFactory(parsed)
      const meta = await client.getFileModification({ fileId })
      if (meta.notFound) {
        return { picked: false, notFound: true }
      }
      // Resolve the SA email so we can filter out the daemon's own write.
      // When the daemon is in OAuth user mode, lastModifyingUser is the user
      // themselves — distinguishable from a "picker" only by comparison
      // against the publishing identity. For OAuth mode v1 we treat any
      // modifiedTime > publishedAt as a pick (the user picked their own work).
      let saEmail: string | undefined
      if (parsed.auth.service_account_key_path) {
        const keyJson = JSON.parse(
          await readFile(
            expandUser(parsed.auth.service_account_key_path),
            'utf8',
          ),
        ) as { client_email?: string }
        saEmail = keyJson.client_email
      }

      const result: DetectPickResult = { picked: false }
      if (meta.modifiedTime) result.modifiedAtIso = meta.modifiedTime
      if (meta.lastModifyingUser) result.modifiedBy = meta.lastModifyingUser

      // Pick conditions:
      //  1. modifiedTime > publishedAt (artifact was touched after we wrote it)
      //  2. AND (SA mode: lastModifyingUser !== SA email)
      //     OR (OAuth mode: any post-publish modification counts)
      //
      // Drive omits `lastModifyingUser.emailAddress` for users with privacy
      // settings hiding their email. SA writes ALWAYS include the SA email
      // (service-account identities aren't privacy-restricted). So we treat
      // a missing email as "definitely not the SA" rather than "unknown" —
      // a false positive (spurious picked score) is much cheaper for the
      // eval loop than a false negative (missed pick = lost signal).
      const wasModifiedAfterPublish =
        !!meta.modifiedTime &&
        Date.parse(meta.modifiedTime) > Date.parse(publishedAtIso)
      const isHumanEdit = saEmail ? meta.lastModifyingUser !== saEmail : true
      result.picked = wasModifiedAfterPublish && isHumanEdit
      return result
    },

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
          adapterName: 'google-drive',
          error: `invalid config for destination "${targetName}": ${parsed.error.message}`,
        }
      }
      const cfg = parsed.data

      try {
        const client = await uploadClientFactory(cfg)
        const filename = resolveFilename(cfg.filename, cfg.format, now())
        const created = await client.createFile({
          name: filename,
          parents: [cfg.destination_folder_id],
          mimeType: 'text/markdown',
          body: copy,
          convertToGoogleDoc: cfg.format === 'google_doc',
        })
        const result: ShipResult = {
          ok: true,
          destinationName: targetName,
          adapterName: 'google-drive',
          detail: `wrote ${copy.length} chars as ${cfg.format} "${created.name}" (id=${created.id})`,
          fileId: created.id,
        }
        if (created.webViewLink) result.url = created.webViewLink
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          destinationName: targetName,
          adapterName: 'google-drive',
          error: msg,
        }
      }
    },
  }
}

export const googleDriveDestination: DestinationAdapter =
  createGoogleDriveDestination()

// ─── Test helpers ───────────────────────────────────────────────────────────

export type GoogleDriveDestinationConfig = z.input<typeof configSchema>
export type GoogleDriveDestinationConfigParsed = z.infer<typeof configSchema>

export function _parseGoogleDriveDestinationConfig(config: unknown): Config {
  return configSchema.parse(config)
}

export const _resolveFilename = resolveFilename
