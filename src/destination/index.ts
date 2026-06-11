/**
 * DestinationAdapter interface.
 *
 * V2 (per ADR) — content-author workflow lands picked copy in a real
 * destination (file, Jira, Confluence, Slack, GitHub PR, etc.). Each
 * adapter implements one interface and registers under a name. Brand-kit
 * declares per-project destinations as `entries: { name: { adapter, config } }`.
 *
 * Lifecycle:
 *   1. Operator runs `gen` → picks variant text.
 *   2. Operator runs `ship --copy-from <path> --destination <name>`.
 *   3. CLI looks up `brand-kit.destinations.entries.<name>` → finds the adapter
 *      name + config → dispatches to the registered DestinationAdapter.
 *   4. Adapter validates its config, performs the publish, returns a ShipResult.
 *
 * Brand-kit doesn't dictate adapter capabilities — each adapter validates
 * its own config (Zod schemas live inside the adapter file). This keeps the
 * brand-kit schema minimal and adapters extensible.
 *
 * Sibling shape to Grader + GroundingSource. The pipeline is generic; the
 * plug-in interfaces are what vary across consuming projects.
 */

export interface ShipResult {
  ok: boolean
  /** The destination key from brand-kit.destinations.entries. */
  destinationName: string
  /** The adapter that handled the publish (`output-file`, `atlassian-mcp`, ...). */
  adapterName: string
  /** Human-readable detail (chars written, ticket ID, message ID, etc.). */
  detail?: string
  /** Optional URL to the shipped artifact (file://, https://jira/..., etc.). */
  url?: string
  /** Stable artifact identifier the daemon can pass back to detectPick().
   *  Drive adapters return the file id; git-commit-pr returns the commit
   *  sha; output-file returns the absolute path. Adapters that don't have
   *  a stable id omit this — those destinations can't participate in pick
   *  detection. */
  fileId?: string
  /** Error message when ok=false. */
  error?: string
}

export interface PublishArgs {
  /** The picked copy text being shipped. */
  copy: string
  /** The destination key from brand-kit.destinations.entries. */
  targetName: string
  /** Adapter-specific config from brand-kit.destinations.entries.<name>.config. */
  config: Record<string, unknown>
}

/** Optional pre-flight check the daemon runs at startup. Returns ok=false with
 *  a specific error when the destination is misconfigured in a way that would
 *  silently fail at first publish (e.g. SA + personal Drive folder = 403
 *  storageQuotaExceeded only at write time). Implementations should be cheap
 *  metadata reads, not full test publishes. */
export interface PreflightArgs {
  targetName: string
  config: Record<string, unknown>
}

export interface PreflightResult {
  ok: boolean
  /** Adapter name, for log lines. */
  adapterName: string
  /** Destination key from brand-kit.destinations.entries. */
  destinationName: string
  /** Specific error when ok=false. Should name the misconfiguration + the fix. */
  error?: string
  /** Optional info line on success (e.g. resolved Shared Drive name). */
  detail?: string
}

/** Optional pick-detection check the daemon runs against each published
 *  artifact. "Pick" here means: an operator has touched the artifact after
 *  publish — they edited it, moved it, or otherwise signalled it's the
 *  variant they want. Drive-style implementations check modifiedTime +
 *  lastModifyingUser. Adapters without a natural pick signal omit this
 *  method; the daemon then can't emit pick scores for that destination. */
export interface DetectPickArgs {
  /** The artifact's stable id (e.g. Google Doc id, ticket id). */
  fileId: string
  /** Adapter config (same shape passed to publish()/preflight()). */
  config: Record<string, unknown>
  /** ISO timestamp of when the daemon published this artifact. Pick
   *  detection should ignore modifications at or before this. */
  publishedAtIso: string
}

export interface DetectPickResult {
  /** True iff a post-publish human modification was detected. */
  picked: boolean
  /** ISO timestamp of the most recent modification (whether picked or not). */
  modifiedAtIso?: string
  /** Identifier of the user who made the most recent modification (e.g. email
   *  address). Empty when adapter can't resolve. Used to filter out the
   *  daemon's own service-account-driven writes. */
  modifiedBy?: string
  /** When `picked === false` because the artifact is gone (deleted/moved
   *  out of the destination), set this so the daemon can prune the entry. */
  notFound?: boolean
}

export interface DestinationAdapter {
  /** Stable identifier matching brand-kit.destinations.entries.<name>.adapter. */
  name: string
  /** Human description. */
  description?: string
  /** Perform the publish. Errors should be returned via ShipResult.error,
   *  not thrown — keeps the CLI predictable. */
  publish(args: PublishArgs): Promise<ShipResult>
  /** Optional startup check. Daemons (copy-pipeline-watch) call this for every
   *  configured destination before the first watch event, so misconfiguration
   *  fails fast and loud instead of at first publish. Adapters without
   *  meaningful preflight checks omit this method. */
  preflight?(args: PreflightArgs): Promise<PreflightResult>
  /** Optional pick detector. Daemons call this periodically against every
   *  published artifact to discover when an operator has signalled a pick
   *  (typically by editing the artifact). Adapters that don't model "pick"
   *  natively omit this method. */
  detectPick?(args: DetectPickArgs): Promise<DetectPickResult>
}

export const DESTINATION_REGISTRY = new Map<string, DestinationAdapter>()

export function registerDestination(d: DestinationAdapter): void {
  DESTINATION_REGISTRY.set(d.name, d)
}

/**
 * Default destination adapter roster. V0.1.0-alpha.7 ships:
 *
 * - `output-file` — writes to a local file path. Real impl.
 * - `git-commit-pr` — writes to a path inside a local git repo, commits on a
 *   feature branch, optionally pushes + opens a PR via `gh`. Real impl.
 * - `google-drive` — writes picked copy back to a Google Drive folder as a
 *   Google Doc (default) or .md file. Real impl.
 * - `atlassian-mcp` — stub; creates a Jira issue or updates a Confluence
 *   page via the Atlassian MCP. Real impl deferred.
 * - `slack-mcp` — stub; posts to a Slack channel via the Slack MCP. Real
 *   impl deferred.
 *
 * Pass a custom array to `ship({ adapters: ... })` to override.
 */
export async function defaultDestinations(): Promise<DestinationAdapter[]> {
  const { outputFileDestination } = await import('./output-file.js')
  const { atlassianMcpDestination } = await import('./atlassian-mcp.js')
  const { slackMcpDestination } = await import('./slack-mcp.js')
  const { gitCommitPrDestination } = await import('./git-commit-pr.js')
  const { googleDriveDestination } = await import('./google-drive.js')

  return [
    outputFileDestination,
    atlassianMcpDestination,
    slackMcpDestination,
    gitCommitPrDestination,
    googleDriveDestination,
  ]
}
