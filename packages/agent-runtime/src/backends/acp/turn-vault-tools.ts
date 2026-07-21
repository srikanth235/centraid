/*
 * Standing the turn's vault tools up as an MCP server the agent can dial.
 *
 * When the turn carries a `ToolContext` and the agent advertises
 * `mcpCapabilities.http`, we stand up a per-turn loopback MCP endpoint
 * (`./vault-mcp-server.ts`) and name it in `mcpServers`. That is the ONE way
 * `vault_sql` / `vault_invoke` / `vault_content` reach any runner kind — see
 * that module for the security posture and why the experimental
 * `type: "acp"` transport isn't an option.
 *
 * Only stand the endpoint up when this turn actually carries vault runners; a
 * builder turn (no vault mounted) advertises no MCP server at all rather than
 * an empty one. An agent that can't take an HTTP MCP server is told so — the
 * vault is never lost silently.
 */

import type { ToolContext, TurnStreamEvent } from '@centraid/app-engine';
import {
  startVaultMcpServer,
  type AcpHttpMcpServer,
  type VaultMcpHandle,
} from './vault-mcp-server.js';

export interface TurnVaultTools {
  /** What to name in `session/new` / `session/load`'s `mcpServers`. */
  mcpServers: AcpHttpMcpServer[];
  /** The live endpoint, to be closed with the turn. Absent when none was started. */
  handle?: VaultMcpHandle;
}

export async function startTurnVaultTools(args: {
  toolContext: ToolContext | undefined;
  /** Did the agent advertise `mcpCapabilities.http` in `initialize`? */
  httpMcp: boolean;
  emit: (event: TurnStreamEvent) => void;
  /** The mapper's open-tool-call probe, used to avoid double-rendering. */
  agentStreamsTool: (toolName: string) => boolean;
}): Promise<TurnVaultTools> {
  const toolCtx = args.toolContext;
  if (!toolCtx?.vaultSql) return { mcpServers: [] };

  if (!args.httpMcp) {
    args.emit({
      type: 'notice',
      level: 'warn',
      code: 'vault_tools_unavailable',
      message:
        'This runner doesn’t support HTTP MCP servers, so it can’t reach your vault data ' +
        '(vault_sql / vault_invoke) on this turn.',
    });
    return { mcpServers: [] };
  }

  const suppressed = new Set<string>();
  try {
    const handle = await startVaultMcpServer(toolCtx, {
      onStart: (call) => {
        if (args.agentStreamsTool(call.toolName)) {
          suppressed.add(call.toolCallId);
          return;
        }
        args.emit({
          type: 'tool.start',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.args,
          ...(typeof call.args.sql === 'string' ? { sql: call.args.sql } : {}),
        });
      },
      onResult: (call) => {
        // Mirror the start decision — never emit a result for a start
        // we suppressed, or the transcript gets an orphan.
        if (suppressed.has(call.toolCallId)) return;
        args.emit({
          type: 'tool.result',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          ok: call.ok,
          result: call.result,
          ...(call.errorText ? { errorText: call.errorText } : {}),
        });
      },
    });
    return { mcpServers: [handle.server], handle };
  } catch (err) {
    // Losing the vault endpoint degrades the turn; it must not fail it.
    args.emit({
      type: 'notice',
      level: 'warn',
      code: 'vault_tools_unavailable',
      message:
        'Couldn’t start the local vault tool endpoint, so this turn can’t reach your vault ' +
        `data: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { mcpServers: [] };
  }
}
