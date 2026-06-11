/**
 * atlassian-mcp destination adapter — STUB.
 *
 * V2 real implementation will dispatch to the operator's Atlassian MCP
 * (`mcp__claude_ai_Atlassian__editJiraIssue` / `createConfluencePage` etc.)
 * to land copy in Jira issues or Confluence pages.
 *
 * Today this stub exists so brand-kits that declare destinations using the
 * "atlassian-mcp" adapter type don't error out — they get an explanatory
 * ShipResult that explains the adapter is registered but not yet wired.
 *
 * Brand-kit config shape (proposed):
 *   {
 *     "adapter": "atlassian-mcp",
 *     "config": {
 *       "target_kind": "jira-issue" | "jira-comment" | "confluence-page",
 *       "project_or_space": "PUX",
 *       "issue_or_page_id": "PUX-123" | "12345" | undefined,
 *       "field": "description" | "comment" | "body"
 *     }
 *   }
 *
 * Real wiring depends on MCP client access from inside the pipeline process,
 * which is a separate plumbing question (the MCPs are configured at the
 * Claude Code session level today, not inside Node processes).
 */

import type { DestinationAdapter, ShipResult, PublishArgs } from './index.js'

export const atlassianMcpDestination: DestinationAdapter = {
  name: 'atlassian-mcp',
  description:
    '[STUB] Atlassian MCP adapter — Jira issues / comments and Confluence pages. Real wiring deferred to V2.',

  async publish({ targetName }: PublishArgs): Promise<ShipResult> {
    return {
      ok: false,
      destinationName: targetName,
      adapterName: 'atlassian-mcp',
      error:
        'atlassian-mcp destination adapter is not yet implemented. Real wiring deferred to V2.',
    }
  },
}
