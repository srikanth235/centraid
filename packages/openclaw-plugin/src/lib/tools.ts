/*
 * Centraid agent tools.
 *
 * Two tools that let the OpenClaw agent reach into a centraid app's data:
 *   - `centraid_get_schema`: returns tables + columns for one app.
 *   - `centraid_sql_select`: runs a single SELECT against one app's data.sqlite.
 *
 * Scoping: each tool takes an `appId` parameter. A `before_tool_call` hook
 * cross-checks that `appId` against the session key — the chat client connects
 * with `sessionKey = "centraid-chat:<appId>"`, so the gateway refuses any
 * cross-app read attempt before the tool runs.
 *
 * **Logging.** Use `api.logger.info/warn/error` for diagnostics. `console.log`
 * from inside a plugin doesn't reach `/tmp/openclaw/*.log` and is effectively
 * black-holed. We currently throw on errors and let the gateway surface them
 * to the model as tool failures — that's enough for production use; reach for
 * the logger if you need to instrument flow for debugging.
 */

import path from 'node:path';
import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { type Registry, readAppSchema, runQuery, RunQueryError } from '@centraid/runtime-core';

export const SESSION_PREFIX = 'centraid-chat:';

/**
 * Extract the app id from a chat session key. Exported for tests; used by the
 * `before_tool_call` hook to derive the calling app from the session.
 *
 * OpenClaw prefixes session keys with `agent:<agentId>:`, so the stored form
 * is e.g. `agent:main:centraid-chat:todos:w1`. We locate `centraid-chat:` as
 * a substring rather than requiring a prefix match.
 */
export function appIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const idx = sessionKey.indexOf(SESSION_PREFIX);
  if (idx < 0) return undefined;
  const rest = sessionKey.slice(idx + SESSION_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? rest : rest.slice(0, colon);
}

/**
 * Returns true only when `sql` is a read-only statement (SELECT or EXPLAIN)
 * and contains no write/DDL/PRAGMA verbs as standalone words. Exported for
 * tests; used inside `centraid_sql_select.execute`.
 */
export function isSelectOnly(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  if (!stripped) return false;
  const first = stripped.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'EXPLAIN') return false;
  return !/\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|pragma)\b/i.test(
    stripped,
  );
}

interface ToolCtx {
  sessionKey?: string;
}

function readSessionKey(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const ctx = value as { sessionKey?: unknown; ctx?: { sessionKey?: unknown } };
  if (typeof ctx.sessionKey === 'string') return ctx.sessionKey;
  if (typeof ctx.ctx?.sessionKey === 'string') return ctx.ctx.sessionKey;
  return undefined;
}

export function registerCentraidTools(api: OpenClawPluginApi, registry: Registry): void {
  const textResult = (text: string, details: Record<string, unknown> = {}) => ({
    content: [{ type: 'text' as const, text }],
    details,
  });

  // Plugin `register()` may run in multiple contexts (gateway process + agent
  // worker), and only the gateway's instance gets `gateway_start` → bootstrap.
  // Lazy-load on first tool call so the worker's registry is hydrated too.
  // `Registry.load` is idempotent.
  const ensureRegistry = async (): Promise<Registry> => {
    await registry.load();
    return registry;
  };

  // ------- centraid_get_schema -------
  api.registerTool({
    name: 'centraid_get_schema',
    label: 'Centraid: get app schema',
    description:
      'Return the tables, columns, indexes, and views of a centraid app’s SQLite database. Use this before issuing centraid_sql_select to know what to query.',
    parameters: Type.Object({
      appId: Type.String({
        description: 'Centraid app id. Must match the active chat’s scope.',
      }),
    }),
    async execute(_id: string, rawParams: unknown, _signal?: AbortSignal, _onUpdate?: unknown) {
      const params = (rawParams ?? {}) as { appId?: string } & ToolCtx;
      const appId = params.appId;
      if (!appId) throw new Error('appId is required.');
      const reg = await ensureRegistry();
      const entry = reg.get(appId);
      if (!entry) throw new Error(`app "${appId}" is not registered.`);
      const schema = readAppSchema(path.join(entry.path, 'data.sqlite'));
      const compact = {
        tables: schema.tables.map((t) => ({
          name: t.name,
          columns: t.columns.map((c) => ({
            name: c.name,
            type: c.type,
            notnull: c.notnull,
            pk: c.pk,
          })),
        })),
        views: schema.views.map((v) => v.name),
        indexes: schema.indexes.map((i) => ({ name: i.name, table: i.tbl_name })),
      };
      return textResult(JSON.stringify(compact), compact);
    },
  });

  // ------- centraid_sql_select -------
  api.registerTool({
    name: 'centraid_sql_select',
    label: 'Centraid: run SELECT',
    description:
      'Run a single SELECT statement against a centraid app’s SQLite database and return the rows. Reads only; writes/DDL are refused.',
    parameters: Type.Object({
      appId: Type.String({
        description: 'Centraid app id. Must match the active chat’s scope.',
      }),
      sql: Type.String({
        description: 'A single SELECT (or EXPLAIN) statement. No semicolons mid-statement.',
      }),
    }),
    async execute(_id: string, rawParams: unknown, _signal?: AbortSignal, _onUpdate?: unknown) {
      const params = (rawParams ?? {}) as { appId?: string; sql?: string };
      const appId = params.appId;
      const sql = params.sql;
      if (!appId || !sql) throw new Error('both appId and sql are required.');
      if (!isSelectOnly(sql)) throw new Error('only SELECT statements are allowed.');
      const reg = await ensureRegistry();
      const entry = reg.get(appId);
      if (!entry) throw new Error(`app "${appId}" is not registered.`);
      try {
        const result = runQuery(path.join(entry.path, 'data.sqlite'), sql);
        if (result.kind !== 'rows') {
          throw new Error('query produced a write result, not rows.');
        }
        const trimmed = result.rows.slice(0, 50);
        const payload = {
          columns: result.columns,
          rows: trimmed,
          totalRows: result.rows.length,
          truncated: result.rows.length > trimmed.length,
          durationMs: result.durationMs,
        };
        return textResult(JSON.stringify(payload), payload);
      } catch (err) {
        const msg =
          err instanceof RunQueryError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        throw new Error(`SQL error: ${msg}`, { cause: err });
      }
    },
  });

  // ------- Scope guard -------
  // The chat client always opens its session as `centraid-chat:<appId>[:<...>]`.
  // Enforce: if a tool call goes to a centraid_* tool, the params.appId must
  // match the session's app, regardless of what the model tries to do.
  //
  // Hook signature is `(event, ctx)`. The session key lives on `ctx`.
  api.on('before_tool_call', async (event, ctx) => {
    const name = event.toolName;
    if (name !== 'centraid_sql_select' && name !== 'centraid_get_schema') return;
    const sessionKey =
      readSessionKey(ctx) ??
      readSessionKey(event) ??
      readSessionKey((event as { context?: unknown }).context);
    const scopedApp = appIdFromSessionKey(sessionKey);
    if (!scopedApp) {
      return {
        block: true,
        blockReason:
          'centraid_* tools require a session opened with sessionKey "centraid-chat:<appId>".',
      };
    }
    const params = (event.params ?? {}) as { appId?: string };
    if (params.appId && params.appId !== scopedApp) {
      return {
        block: true,
        blockReason: `Refused: tool tried to read app "${params.appId}" but the chat is scoped to "${scopedApp}".`,
      };
    }
    // Auto-fill appId if the model forgot it.
    if (!params.appId) {
      return { params: { ...event.params, appId: scopedApp } };
    }
    return undefined;
  });
}
