/*
 * Centraid agent tools.
 *
 * Three structured tools that let the OpenClaw agent address a centraid
 * app's declared surface plus the runtime's `_sql` escape hatch:
 *   - `centraid_describe`: app manifest + live schema (or a single
 *     handler entry).
 *   - `centraid_read`: invoke a declared query, or `_sql` for a SELECT.
 *   - `centraid_write`: invoke a declared action, or `_sql` for a write.
 *
 * Scoping: each tool takes an `app` parameter. A `before_tool_call` hook
 * cross-checks that `app` against the session key — the chat client connects
 * with `sessionKey = "centraid-chat:<appId>"`, so the gateway refuses any
 * cross-app read attempt before the tool runs.
 *
 * **Logging.** Use `api.logger.info/warn/error` for diagnostics. `console.log`
 * from inside a plugin doesn't reach `/tmp/openclaw/*.log` and is effectively
 * black-holed. We currently throw on errors and let the gateway surface them
 * to the model as tool failures — that's enough for production use; reach for
 * the logger if you need to instrument flow for debugging.
 */

import { Type } from '@sinclair/typebox';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { type Runtime, type ToolResult } from '@centraid/runtime-core';

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

function readSessionKey(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const ctx = value as { sessionKey?: unknown; ctx?: { sessionKey?: unknown } };
  if (typeof ctx.sessionKey === 'string') return ctx.sessionKey;
  if (typeof ctx.ctx?.sessionKey === 'string') return ctx.ctx.sessionKey;
  return undefined;
}

export function registerCentraidTools(api: OpenClawPluginApi, runtime: Runtime): void {
  const { registry, dispatcher } = runtime;

  const textResult = (text: string, details: Record<string, unknown> = {}) => ({
    content: [{ type: 'text' as const, text }],
    details,
  });

  /**
   * Translate a runtime-core `ToolResult` into the OpenClaw tool-result
   * shape. Successes pass `structuredContent` through as `details`;
   * errors throw so the gateway returns the MCP-shaped `isError` block
   * to the agent. (The agent runtime treats a thrown error and an
   * `isError` payload identically — both surface as a tool failure.)
   */
  const fromDispatch = (result: ToolResult) => {
    if (result.isError) {
      const { code, message, path } = result.structuredContent;
      const wrap = new Error(`[${code}] ${message}${path ? ` (at ${path})` : ''}`);
      (wrap as Error & { code?: string }).code = code;
      throw wrap;
    }
    return textResult(JSON.stringify(result.structuredContent ?? null), {
      result: result.structuredContent,
    });
  };

  // Plugin `register()` may run in multiple contexts (gateway process + agent
  // worker), and only the gateway's instance gets `gateway_start` → bootstrap.
  // Lazy-load on first tool call so the worker's registry is hydrated too.
  // `Registry.load` is idempotent.
  const ensureRegistry = async (): Promise<typeof registry> => {
    await registry.load();
    return registry;
  };

  // ------- centraid_describe -------
  // Manifest-driven introspection: returns the app manifest (or a
  // filtered slice). The agent calls this before `centraid_write` /
  // `_read` to discover what actions/queries an app exposes and the
  // JSON Schema each accepts.
  api.registerTool({
    name: 'centraid_describe',
    label: 'Centraid: describe app surface',
    description:
      "Return the app manifest (or a filtered slice). With no `app`, lists every registered app. With `app`, returns that app's full manifest. With `app` + `action` or `app` + `query`, returns the single handler entry. Use before centraid_write/read to know what handlers exist and what JSON Schema each input must match.",
    parameters: Type.Object({
      app: Type.Optional(Type.String({ description: 'App id to filter to.' })),
      action: Type.Optional(Type.String({ description: 'Action name to narrow to.' })),
      query: Type.Optional(Type.String({ description: 'Query name to narrow to.' })),
    }),
    async execute(_id: string, rawParams: unknown) {
      const params = (rawParams ?? {}) as {
        app?: string;
        action?: string;
        query?: string;
      };
      await ensureRegistry();
      return fromDispatch(
        await dispatcher.describe({
          ...(params.app ? { app: params.app } : {}),
          ...(params.action ? { action: params.action } : {}),
          ...(params.query ? { query: params.query } : {}),
        }),
      );
    },
  });

  // ------- centraid_write -------
  // Action dispatch. Validates `input` against the manifest's JSON
  // Schema with Ajv before invoking the handler in the worker thread;
  // emits the change-bus event for any tables the handler writes (so
  // app iframes refresh).
  api.registerTool({
    name: 'centraid_write',
    label: 'Centraid: invoke action',
    description:
      "Invoke an app's action handler. The dispatcher validates `input` against the JSON Schema declared in the manifest, then runs the handler in a worker. Use centraid_describe first to discover available actions and their input shape. Returns the action's body payload.",
    parameters: Type.Object({
      app: Type.String({
        description: 'Centraid app id. Must match the active chat’s scope.',
      }),
      action: Type.String({ description: 'Name of the action under `actions[]`.' }),
      input: Type.Optional(
        Type.Unknown({
          description: 'Input matching the action manifest’s `input` JSON Schema.',
        }),
      ),
    }),
    async execute(_id: string, rawParams: unknown) {
      const params = (rawParams ?? {}) as {
        app?: string;
        action?: string;
        input?: unknown;
      };
      if (!params.app || !params.action) {
        throw new Error('both app and action are required.');
      }
      await ensureRegistry();
      return fromDispatch(
        await dispatcher.write({
          app: params.app,
          action: params.action,
          input: params.input,
        }),
      );
    },
  });

  // ------- centraid_read -------
  // Query dispatch. Symmetric with centraid_write but for read-only
  // handlers under `queries/`.
  api.registerTool({
    name: 'centraid_read',
    label: 'Centraid: invoke query',
    description:
      "Invoke an app's query handler. Read-only; validates `input` against the manifest’s JSON Schema. Use centraid_describe first to learn what queries an app exposes.",
    parameters: Type.Object({
      app: Type.String({
        description: 'Centraid app id. Must match the active chat’s scope.',
      }),
      query: Type.String({ description: 'Name of the query under `queries[]`.' }),
      input: Type.Optional(
        Type.Unknown({
          description: 'Input matching the query manifest’s `input` JSON Schema.',
        }),
      ),
    }),
    async execute(_id: string, rawParams: unknown) {
      const params = (rawParams ?? {}) as {
        app?: string;
        query?: string;
        input?: unknown;
      };
      if (!params.app || !params.query) {
        throw new Error('both app and query are required.');
      }
      await ensureRegistry();
      return fromDispatch(
        await dispatcher.read({
          app: params.app,
          query: params.query,
          input: params.input,
        }),
      );
    },
  });

  // ------- Scope guard -------
  // The chat client always opens its session as `centraid-chat:<appId>[:<...>]`.
  // Enforce: if a tool call goes to a centraid_* tool, the params.app must
  // match the session's app, regardless of what the model tries to do.
  //
  // Hook signature is `(event, ctx)`. The session key lives on `ctx`.
  api.on('before_tool_call', async (event, ctx) => {
    const name = event.toolName;
    if (name !== 'centraid_write' && name !== 'centraid_read' && name !== 'centraid_describe')
      return;
    // centraid_describe with no `app` is the only legal cross-app
    // call — "list all registered apps". Skip the scope guard for it.
    if (name === 'centraid_describe') {
      const params = (event.params ?? {}) as { app?: string };
      if (!params.app) return;
    }
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
    const params = (event.params ?? {}) as { app?: string };
    const claimed = params.app;
    if (claimed && claimed !== scopedApp) {
      return {
        block: true,
        blockReason: `Refused: tool tried to address app "${claimed}" but the chat is scoped to "${scopedApp}".`,
      };
    }
    if (!claimed) {
      return { params: { ...event.params, app: scopedApp } };
    }
    return undefined;
  });
}
