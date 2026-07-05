/*
 * Codex-side wiring for the vault-register tools — the ONE tool family
 * (issue #286 phase 2). The pre-vault `centraid_describe/read/write` trio
 * died with the per-app data.sqlite. This module owns two narrow things:
 *
 *   1. The `dynamicTools` array we declare on `thread/start` — the vault
 *      register when the turn carries runners, else nothing.
 *   2. The `item/tool/call` dispatch that delegates to the turn's
 *      `ToolContext.vaultSql` / `vaultInvoke` runners.
 *
 * Schema reference: `codex-rs/app-server-protocol/src/protocol/v2/{thread,item}.rs`.
 */
import type { TurnStreamEvent } from '@centraid/app-engine';
import type { ToolContext } from '../../runtime.js';
import {
  VAULT_INVOKE_TOOL,
  VAULT_SQL_TOOL,
  runVaultInvokeTool,
  runVaultSqlTool,
} from '../../vault-sql-tool.js';

/**
 * Codex `dynamicTools` spec. Names/descriptions/schemas are shared with
 * the claude MCP server through `vault-sql-tool.ts` so the model sees an
 * identical surface across backends. Empty when the turn carries no vault
 * runner — there are no other data tools any more.
 */
export function centraidDynamicToolSpecs(ctx?: ToolContext): Array<{
  name: string;
  description: string;
  inputSchema: unknown;
}> {
  if (!ctx?.vaultSql) return [];
  return [
    {
      name: VAULT_SQL_TOOL.name,
      description: VAULT_SQL_TOOL.description,
      inputSchema: VAULT_SQL_TOOL.inputSchema,
    },
    ...(ctx.vaultInvoke
      ? [
          {
            name: VAULT_INVOKE_TOOL.name,
            description: VAULT_INVOKE_TOOL.description,
            inputSchema: VAULT_INVOKE_TOOL.inputSchema as unknown,
          },
        ]
      : []),
  ];
}

export interface DynamicToolCallOutcome {
  /** JSON-RPC response payload to write back to codex over stdio. */
  response: {
    jsonrpc: '2.0';
    id: number;
    result: { success: boolean; contentItems: Array<{ type: 'inputText'; text: string }> };
  };
  /** Events to forward into the normalized `TurnStreamEvent` stream. */
  events: TurnStreamEvent[];
}

/**
 * Run one `item/tool/call` server request. Reads the documented
 * `DynamicToolCallParams { tool, callId, arguments }` shape out of the
 * codex payload, dispatches to the turn's vault runners, and returns both
 * the RPC reply and the `tool.start` / `tool.result` events the driver
 * should emit. Errors map to `success: false` with the message in
 * `contentItems[0]`; we never throw out of here so the JSON-RPC loop
 * stays responsive.
 */
export async function handleCentraidToolCall(
  id: number,
  params: unknown,
  ctx: ToolContext,
): Promise<DynamicToolCallOutcome> {
  const p = (params ?? {}) as {
    tool?: string;
    callId?: string;
    arguments?: Record<string, unknown>;
  };
  const toolName = String(p.tool ?? '');
  const args = p.arguments ?? {};
  const callId = typeof p.callId === 'string' ? p.callId : `tool-${id}`;

  const events: TurnStreamEvent[] = [
    { type: 'tool.start', toolCallId: callId, toolName, args, ...sqlOf(args) },
  ];

  const out =
    toolName === VAULT_SQL_TOOL.name
      ? await runVaultSqlTool(ctx, (args as { sql?: unknown }).sql)
      : toolName === VAULT_INVOKE_TOOL.name
        ? await runVaultInvokeTool(ctx, args)
        : { ok: false as const, errorText: `unknown tool "${toolName}"` };

  if (out.ok) {
    events.push({
      type: 'tool.result',
      toolCallId: callId,
      toolName,
      ok: true,
      result: out.result,
    });
    return {
      response: {
        jsonrpc: '2.0',
        id,
        result: {
          success: true,
          contentItems: [{ type: 'inputText', text: JSON.stringify(out.result) }],
        },
      },
      events,
    };
  }
  events.push({
    type: 'tool.result',
    toolCallId: callId,
    toolName,
    ok: false,
    result: null,
    errorText: out.errorText,
  });
  return {
    response: {
      jsonrpc: '2.0',
      id,
      result: {
        success: false,
        contentItems: [{ type: 'inputText', text: out.errorText }],
      },
    },
    events,
  };
}

/** Surface the SQL string on a `vault_sql` tool.start event. */
function sqlOf(args: { sql?: unknown }): { sql?: string } {
  return typeof args.sql === 'string' ? { sql: args.sql } : {};
}
