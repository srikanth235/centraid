/*
 * Codex-side wiring for the three first-class `centraid_sql_*` tools.
 *
 * Split out of `codex-app-server.ts` to keep that file focused on the
 * generic JSON-RPC drive loop. This module owns two narrow things:
 *
 *   1. The `dynamicTools` array we declare on `thread/start`.
 *   2. The synchronous `item/tool/call` dispatch that executes one of
 *      the three ops against the active app's SQLite and replies with
 *      the documented `DynamicToolCallResponse` shape.
 *
 * Schema reference: `codex-rs/app-server-protocol/src/protocol/v2/{thread,item}.rs`.
 */

import {
  describeOp,
  readOp,
  writeOp,
  SqlOpRefusal,
  RunQueryError,
  type ChatStreamEvent,
} from '@centraid/runtime-core';
import type { ToolContext } from './runtime.js';

/**
 * Codex `dynamicTools` spec for the three first-class centraid SQL tools.
 * Schemas mirror the documented surface; codex's `DynamicToolSpec.inputSchema`
 * accepts standard JSON Schema.
 */
export function centraidDynamicToolSpecs(): Array<{
  name: string;
  description: string;
  inputSchema: unknown;
}> {
  return [
    {
      name: 'centraid_sql_describe',
      description:
        "Return the live SQLite schema for this app (tables, columns, indexes, views) as JSON. Call this first when you don't know the schema. No arguments.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'centraid_sql_read',
      description:
        "Run one SELECT (or EXPLAIN) against this app's SQLite. Returns {columns, rows, totalRows, truncated, durationMs}. Rows are capped at 200 — use LIMIT to be explicit. DDL/PRAGMA/non-SELECT statements are refused.",
      inputSchema: {
        type: 'object',
        required: ['sql'],
        properties: {
          sql: { type: 'string', description: 'A single SELECT or EXPLAIN statement.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'centraid_sql_write',
      description:
        "Run one INSERT / UPDATE / DELETE / REPLACE against this app's SQLite. Returns {rowsAffected, lastInsertRowid, durationMs}. DDL (CREATE/ALTER/DROP), PRAGMA, ATTACH/DETACH, VACUUM are refused. The runtime fires its change bus after the write so the running app's UI re-renders automatically.",
      inputSchema: {
        type: 'object',
        required: ['sql'],
        properties: {
          sql: {
            type: 'string',
            description: 'A single INSERT/UPDATE/DELETE/REPLACE statement.',
          },
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
  /** Events to forward into the normalized `ChatStreamEvent` stream. */
  events: ChatStreamEvent[];
}

/**
 * Synchronously run one `item/tool/call` server request. Reads the
 * documented `DynamicToolCallParams { tool, callId, arguments }` shape
 * out of the codex payload, dispatches to the shared ops, and returns
 * both the RPC reply and the `tool.start` / `tool.result` events the
 * driver should emit.
 *
 * Errors map to `success: false` with the message in `contentItems[0]`;
 * we never throw out of here so the JSON-RPC loop stays responsive.
 */
export function handleCentraidToolCall(
  id: number,
  params: unknown,
  ctx: ToolContext,
): DynamicToolCallOutcome {
  const p = (params ?? {}) as {
    tool?: string;
    callId?: string;
    arguments?: Record<string, unknown>;
  };
  const toolName = String(p.tool ?? '');
  const args = (p.arguments ?? {}) as { sql?: string };
  const callId = typeof p.callId === 'string' ? p.callId : `tool-${id}`;

  const events: ChatStreamEvent[] = [
    { type: 'tool.start', toolCallId: callId, toolName, args, sql: args.sql },
  ];

  try {
    let payload: unknown;
    if (toolName === 'centraid_sql_describe') {
      payload = describeOp({ dataFile: ctx.dataFile });
    } else if (toolName === 'centraid_sql_read') {
      if (typeof args.sql !== 'string') throw new Error('sql argument required');
      payload = readOp({ dataFile: ctx.dataFile, sql: args.sql });
    } else if (toolName === 'centraid_sql_write') {
      if (typeof args.sql !== 'string') throw new Error('sql argument required');
      payload = writeOp({
        dataFile: ctx.dataFile,
        sql: args.sql,
        onWrite: (tables) => ctx.emitChange({ tables, toolCallId: callId }),
      });
    } else {
      throw new Error(`unknown tool "${toolName}"`);
    }
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
    const msg =
      err instanceof SqlOpRefusal
        ? err.message
        : err instanceof RunQueryError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
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
