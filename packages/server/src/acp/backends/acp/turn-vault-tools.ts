import { fileURLToPath } from "node:url";

import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";

import type { ToolContext, TurnStreamEvent } from "@centraid/server/engine";

import {
  startVaultMcpServer,
  VAULT_MCP_SERVER_NAME,
} from "./vault-mcp-server.js";
import type { VaultMcpHandle } from "./vault-mcp-server.js";

const STDIO_PROXY = fileURLToPath(
  new URL("vault-mcp-stdio-proxy.mjs", import.meta.url).href
);

export interface TurnVaultTools {
  mcpServers: McpServer[];
  handle?: VaultMcpHandle;
  transport?: "http" | "stdio";
}

export async function startTurnVaultTools(args: {
  toolContext: ToolContext | undefined;
  httpMcp: boolean;
  emit: (event: TurnStreamEvent) => void;
  harnessStreamsTool: (toolName: string) => boolean;
}): Promise<TurnVaultTools> {
  const toolCtx = args.toolContext;
  if (!toolCtx?.vaultSql) return { mcpServers: [] };

  const suppressed = new Set<string>();
  try {
    const handle = await startVaultMcpServer(toolCtx, {
      onStart: (call) => {
        if (args.harnessStreamsTool(call.toolName)) {
          suppressed.add(call.toolCallId);
          return;
        }
        args.emit({
          type: "tool.start",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.args,
          ...(typeof call.args.sql === "string" ? { sql: call.args.sql } : {}),
        });
      },
      onResult: (call) => {
        if (suppressed.has(call.toolCallId)) return;
        args.emit({
          type: "tool.result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          ok: call.ok,
          result: call.result,
          ...(call.errorText ? { errorText: call.errorText } : {}),
        });
      },
    });

    if (args.httpMcp) {
      return { mcpServers: [handle.server], handle, transport: "http" };
    }

    const bearer =
      handle.server.headers.find(
        (h) => h.name.toLowerCase() === "authorization"
      )?.value ?? "";
    const token = bearer.replace(/^Bearer\s+/iu, "");
    const stdio: McpServerStdio = {
      name: VAULT_MCP_SERVER_NAME,
      command: process.execPath,
      args: [STDIO_PROXY],
      env: [
        { name: "CENTRAID_VAULT_MCP_URL", value: handle.server.url },
        { name: "CENTRAID_VAULT_MCP_TOKEN", value: token },
      ],
    };
    args.emit({
      type: "notice",
      level: "info",
      code: "vault_tools_stdio",
      message:
        "This harness doesn’t support HTTP MCP — vault tools are bridged over stdio MCP instead.",
    });
    return { mcpServers: [stdio], handle, transport: "stdio" };
  } catch (error) {
    args.emit({
      type: "notice",
      level: "warn",
      code: "vault_tools_unavailable",
      message:
        "Couldn’t start the local vault tool endpoint, so this turn can’t reach your vault " +
        `data: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { mcpServers: [] };
  }
}
