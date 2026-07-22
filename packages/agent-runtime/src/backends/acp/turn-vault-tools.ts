/*
 * Standing the turn's vault tools up as an MCP server the agent can dial.
 *
 * Prefer HTTP MCP when the agent advertises `mcpCapabilities.http` (the path
 * first-party adapters support). When it does not, still stand up the
 * loopback HTTP endpoint and advertise a **stdio MCP** entry that runs
 * `vault-mcp-stdio-proxy.mjs` — agents MUST support stdio MCP per ACP, so
 * vault tools reach them without silent loss.
 */

import { fileURLToPath } from 'node:url';
import type { ToolContext, TurnStreamEvent } from '@centraid/app-engine';
import {
  startVaultMcpServer,
  type AcpHttpMcpServer,
  type VaultMcpHandle,
  VAULT_MCP_SERVER_NAME,
} from './vault-mcp-server.js';

const STDIO_PROXY = fileURLToPath(new URL('vault-mcp-stdio-proxy.mjs', import.meta.url));

/** ACP default (stdio) MCP server shape — no `type` field. */
export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export type AcpMcpServer = AcpHttpMcpServer | AcpStdioMcpServer;

export interface TurnVaultTools {
  /** What to name in `session/new` / `session/load` / `session/resume`'s `mcpServers`. */
  mcpServers: AcpMcpServer[];
  /** The live HTTP endpoint, to be closed with the turn. Absent when none was started. */
  handle?: VaultMcpHandle;
  /** How the agent was told to reach the vault (for capability notices). */
  transport?: 'http' | 'stdio';
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

    if (args.httpMcp) {
      return { mcpServers: [handle.server], handle, transport: 'http' };
    }

    // Stdio bridge: agent spawns proxy; proxy dials our loopback HTTP.
    const bearer =
      handle.server.headers.find((h) => h.name.toLowerCase() === 'authorization')?.value ?? '';
    const token = bearer.replace(/^Bearer\s+/i, '');
    const stdio: AcpStdioMcpServer = {
      name: VAULT_MCP_SERVER_NAME,
      command: process.execPath,
      args: [STDIO_PROXY],
      env: [
        { name: 'CENTRAID_VAULT_MCP_URL', value: handle.server.url },
        { name: 'CENTRAID_VAULT_MCP_TOKEN', value: token },
      ],
    };
    args.emit({
      type: 'notice',
      level: 'info',
      code: 'vault_tools_stdio',
      message:
        'This runner doesn’t support HTTP MCP — vault tools are bridged over stdio MCP instead.',
    });
    return { mcpServers: [stdio], handle, transport: 'stdio' };
  } catch (err) {
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
