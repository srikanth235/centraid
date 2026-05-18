/*
 * Centraid agent tools.
 *
 * Two tools that let the OpenClaw agent reach into a centraid app's data:
 *   - `centraid_sql_describe`: returns tables + columns for one app.
 *   - `centraid_sql_read`: runs a single SELECT against one app's data.sqlite.
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
import { type Runtime, readAppSchema, runQuery, RunQueryError } from '@centraid/runtime-core';

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
 * tests; used inside `centraid_sql_read.execute`.
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

/**
 * Returns true when `sql` is a row-mutating DML statement (INSERT/UPDATE/
 * DELETE/REPLACE) and contains no DDL/PRAGMA/ATTACH verbs. We intentionally
 * keep DDL out of the write path so the model cannot reshape the schema —
 * migrations are the app author's responsibility.
 */
export function isWriteDml(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  if (!stripped) return false;
  const first = stripped.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (first !== 'INSERT' && first !== 'UPDATE' && first !== 'DELETE' && first !== 'REPLACE') {
    return false;
  }
  return !/\b(drop|alter|create|attach|detach|vacuum|reindex|pragma)\b/i.test(stripped);
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

export function registerCentraidTools(api: OpenClawPluginApi, runtime: Runtime): void {
  const { registry, changeBus } = runtime;

  const textResult = (text: string, details: Record<string, unknown> = {}) => ({
    content: [{ type: 'text' as const, text }],
    details,
  });

  // Plugin `register()` may run in multiple contexts (gateway process + agent
  // worker), and only the gateway's instance gets `gateway_start` → bootstrap.
  // Lazy-load on first tool call so the worker's registry is hydrated too.
  // `Registry.load` is idempotent.
  const ensureRegistry = async (): Promise<typeof registry> => {
    await registry.load();
    return registry;
  };

  // ------- centraid_sql_describe -------
  api.registerTool({
    name: 'centraid_sql_describe',
    label: 'Centraid: get app schema',
    description:
      'Return the tables, columns, indexes, and views of a centraid app’s SQLite database. Use this before issuing centraid_sql_read to know what to query.',
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

  // ------- centraid_sql_read -------
  api.registerTool({
    name: 'centraid_sql_read',
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

  // ------- centraid_sql_write -------
  // Row-mutating DML against a single centraid app. Returns a small JSON
  // payload describing the side effects (rowsAffected, lastInsertRowid). The
  // scope guard below enforces the same app-id check that protects the read
  // tool, so the model cannot mutate another app's data.
  api.registerTool({
    name: 'centraid_sql_write',
    label: 'Centraid: run INSERT/UPDATE/DELETE',
    description:
      'Run a single INSERT, UPDATE, DELETE, or REPLACE statement against a centraid app’s SQLite database. Returns rowsAffected and lastInsertRowid. DDL (CREATE/ALTER/DROP) and PRAGMA are not allowed — use centraid_sql_describe first to learn the existing tables and columns.',
    parameters: Type.Object({
      appId: Type.String({
        description: 'Centraid app id. Must match the active chat’s scope.',
      }),
      sql: Type.String({
        description:
          'A single INSERT/UPDATE/DELETE/REPLACE statement. No semicolons mid-statement, no DDL.',
      }),
    }),
    async execute(_id: string, rawParams: unknown, _signal?: AbortSignal, _onUpdate?: unknown) {
      const params = (rawParams ?? {}) as { appId?: string; sql?: string };
      const appId = params.appId;
      const sql = params.sql;
      if (!appId || !sql) throw new Error('both appId and sql are required.');
      if (!isWriteDml(sql)) {
        throw new Error(
          'only INSERT/UPDATE/DELETE/REPLACE are allowed; DDL and PRAGMA are refused.',
        );
      }
      const reg = await ensureRegistry();
      const entry = reg.get(appId);
      if (!entry) throw new Error(`app "${appId}" is not registered.`);
      try {
        const result = runQuery(path.join(entry.path, 'data.sqlite'), sql, {
          // Fire the runtime's change bus so app iframes subscribed via
          // /centraid/<id>/_changes re-fetch after this write — same as
          // the HTTP query route path does.
          onWrite: (tables) => {
            if (tables.length === 0) return;
            changeBus.emit({ appId, tables, ts: Date.now(), source: 'agent' });
          },
        });
        if (result.kind !== 'exec') {
          throw new Error('statement produced rows, not an exec result.');
        }
        const payload = {
          rowsAffected: result.rowsAffected,
          lastInsertRowid:
            typeof result.lastInsertRowid === 'bigint'
              ? result.lastInsertRowid.toString()
              : result.lastInsertRowid,
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
    if (
      name !== 'centraid_sql_read' &&
      name !== 'centraid_sql_write' &&
      name !== 'centraid_sql_describe'
    )
      return;
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
