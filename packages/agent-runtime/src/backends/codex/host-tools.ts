/*
 * Codex-side wiring for the three first-class centraid tools.
 *
 * Split out of `backend.ts` to keep that file focused on the
 * generic JSON-RPC drive loop. This module owns two narrow things:
 *
 *   1. The `dynamicTools` array we declare on `thread/start`.
 *   2. The synchronous `item/tool/call` dispatch that delegates to the
 *      shared app-engine `Dispatcher`. The dispatcher resolves declared
 *      handlers from the app's manifest and routes `_sql` to its built-in.
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
 * Codex `dynamicTools` spec for the structured centraid tools. Schemas
 * mirror the documented surface; codex's `DynamicToolSpec.inputSchema`
 * accepts standard JSON Schema. The vault-assistant register
 * (`ToolContext.vaultSql`) swaps the app-scoped trio for the one
 * `vault_sql` tool — an assistant turn has no app to describe or write.
 */
export function centraidDynamicToolSpecs(ctx?: ToolContext): Array<{
  name: string;
  description: string;
  inputSchema: unknown;
}> {
  if (ctx?.vaultSql) {
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
  return [
    {
      name: 'centraid_describe',
      description:
        "Return the app's manifest plus live SQLite schema, or a single declared handler entry. Call without arguments to see the full catalog; pass `action` or `query` to narrow. Use this before centraid_read/centraid_write to know what handlers exist and what input each accepts.",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action name to narrow to.' },
          query: { type: 'string', description: 'Query name to narrow to.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'centraid_read',
      description:
        'Invoke a declared query, or the `_sql` built-in for an ad-hoc SELECT. For declared queries set `query` to the name in the manifest and `input` to its JSON Schema shape. For ad-hoc reads use `query: "_sql"` and `input: { sql: "<single SELECT or EXPLAIN>" }` — rows are capped at 200, use LIMIT for fewer; DDL/PRAGMA refused. Prefer declared queries when one fits the user\'s ask.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Declared query name, or "_sql".' },
          input: { description: 'Input matching the query schema, or { sql } for _sql.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'centraid_write',
      description:
        'Invoke a declared action, or the `_sql` built-in for an ad-hoc INSERT/UPDATE/DELETE/REPLACE. For declared actions set `action` to the name in the manifest and `input` to its JSON Schema shape. For ad-hoc writes use `action: "_sql"` and `input: { sql: "<single statement>" }` — DDL/PRAGMA refused. Prefer declared actions when one fits the user\'s ask. The runtime fires its change bus after a successful write so the app UI re-renders automatically.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', description: 'Declared action name, or "_sql".' },
          input: { description: 'Input matching the action schema, or { sql } for _sql.' },
        },
        additionalProperties: false,
      },
    },
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
 * Synchronously run one `item/tool/call` server request. Reads the
 * documented `DynamicToolCallParams { tool, callId, arguments }` shape
 * out of the codex payload, dispatches to the shared three-tool
 * dispatcher, and returns both the RPC reply and the `tool.start` /
 * `tool.result` events the driver should emit.
 *
 * Errors map to `success: false` with the message in `contentItems[0]`;
 * we never throw out of here so the JSON-RPC loop stays responsive.
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
  const args = (p.arguments ?? {}) as {
    action?: string;
    query?: string;
    input?: unknown;
  };
  const callId = typeof p.callId === 'string' ? p.callId : `tool-${id}`;

  const events: TurnStreamEvent[] = [
    { type: 'tool.start', toolCallId: callId, toolName, args, ...sqlOf(args) },
  ];

  // The vault register: dispatched through the turn's owner/assistant
  // runners instead of the app dispatcher.
  if (toolName === VAULT_SQL_TOOL.name || toolName === VAULT_INVOKE_TOOL.name) {
    const out =
      toolName === VAULT_SQL_TOOL.name
        ? await runVaultSqlTool(ctx, (p.arguments as { sql?: unknown } | undefined)?.sql)
        : await runVaultInvokeTool(ctx, p.arguments);
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

  try {
    let result;
    if (toolName === 'centraid_describe') {
      result = await ctx.dispatcher.describe(
        {
          app: ctx.appId,
          ...(typeof args.action === 'string' ? { action: args.action } : {}),
          ...(typeof args.query === 'string' ? { query: args.query } : {}),
        },
        ctx.overrideCodeDir,
      );
    } else if (toolName === 'centraid_read') {
      if (typeof args.query !== 'string') throw new Error('query argument required');
      result = await ctx.dispatcher.read(
        {
          app: ctx.appId,
          query: args.query,
          input: args.input,
        },
        ctx.overrideCodeDir,
      );
    } else if (toolName === 'centraid_write') {
      if (typeof args.action !== 'string') throw new Error('action argument required');
      result = await ctx.dispatcher.write(
        {
          app: ctx.appId,
          action: args.action,
          input: args.input,
        },
        ctx.overrideCodeDir,
      );
    } else {
      throw new Error(`unknown tool "${toolName}"`);
    }
    if (result.isError) {
      const { code, message } = result.structuredContent;
      const msg = `[${code}] ${message}`;
      events.push({
        type: 'tool.result',
        toolCallId: callId,
        toolName,
        ok: false,
        result: null,
        errorText: msg,
      });
      return {
        response: {
          jsonrpc: '2.0',
          id,
          result: {
            success: false,
            contentItems: [{ type: 'inputText', text: msg }],
          },
        },
        events,
      };
    }
    const payload = result.structuredContent;
    events.push({
      type: 'tool.result',
      toolCallId: callId,
      toolName,
      ok: true,
      result: payload,
    });
    return {
      response: {
        jsonrpc: '2.0',
        id,
        result: {
          success: true,
          contentItems: [{ type: 'inputText', text: JSON.stringify(payload) }],
        },
      },
      events,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    events.push({
      type: 'tool.result',
      toolCallId: callId,
      toolName,
      ok: false,
      result: null,
      errorText: msg,
    });
    return {
      response: {
        jsonrpc: '2.0',
        id,
        result: {
          success: false,
          contentItems: [{ type: 'inputText', text: msg }],
        },
      },
      events,
    };
  }
}

/**
 * Surface the SQL string on a tool.start event when the agent used `_sql`
 * (nested under `input`) or `vault_sql` (top-level `sql` argument).
 */
function sqlOf(args: { action?: string; query?: string; input?: unknown; sql?: unknown }): {
  sql?: string;
} {
  if (typeof args.sql === 'string') return { sql: args.sql };
  if (args.action !== '_sql' && args.query !== '_sql') return {};
  if (!args.input || typeof args.input !== 'object') return {};
  const sql = (args.input as { sql?: unknown }).sql;
  return typeof sql === 'string' ? { sql } : {};
}
