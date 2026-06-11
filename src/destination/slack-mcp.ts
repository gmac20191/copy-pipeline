/**
 * slack-mcp destination adapter — STUB.
 *
 * V2 real implementation will dispatch to the operator's Slack MCP
 * (`mcp__claude_ai_Slack__slack_send_message` /
 * `mcp__claude_ai_Slack__slack_send_message_draft`) to post or draft copy
 * in a Slack channel.
 *
 * Brand-kit config shape (proposed):
 *   {
 *     "adapter": "slack-mcp",
 *     "config": {
 *       "channel": "#announce",
 *       "draft": true | false,
 *       "thread_ts": "..."  (optional, for replies)
 *     }
 *   }
 */

import type { DestinationAdapter, ShipResult, PublishArgs } from './index.js'

export const slackMcpDestination: DestinationAdapter = {
  name: 'slack-mcp',
  description:
    '[STUB] Slack MCP adapter — post or draft a message in a channel. Real wiring deferred to V2.',

  async publish({ targetName }: PublishArgs): Promise<ShipResult> {
    return {
      ok: false,
      destinationName: targetName,
      adapterName: 'slack-mcp',
      error:
        'slack-mcp destination adapter is not yet implemented. Real wiring deferred to V2.',
    }
  },
}
