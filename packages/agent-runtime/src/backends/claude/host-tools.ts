/*
 * Claude-side wiring for the first-class centraid tools.
 *
 * Split out of `backend.ts` to keep that file focused on the SDK drive
 * loop and event translation. This module owns the in-process MCP server
 * that exposes `centraid_describe` / `centraid_read` / `centraid_write`,
 * mirroring codex's `host-tools.ts`. Both backends delegate to the shared
 * app-engine `Dispatcher` so the model sees an identical tool surface.
 *
 * The vault-assistant register (ToolContext.vaultSql) swaps the app-scoped
 * trio for ONE tool — `vault_sql`, owner-side read-only SQL over the whole
 * vault. An assistant turn has no app to describe or write, so the
 * registers swap rather than mix; the description text is shared with the
 * codex spec via `VAULT_SQL_TOOL` below.
 */
import type { ToolContext } from '../../runtime.js';
import {
  VAULT_INVOKE_TOOL,
  VAULT_SQL_TOOL,
  runVaultInvokeTool,
  runVaultSqlTool,
} from '../../vault-sql-tool.js';

/**
 * Build the in-process MCP server that exposes the three structured
 * centraid tools. Zod 4 is the project's pinned schema lib; the SDK
 * accepts both Zod 3 and Zod 4. Each handler delegates to the shared
 * app-engine dispatcher and returns a single `text` content block whose
 * payload is the JSON-stringified result (matching the codex shape) so the
 * model sees an identical surface across backends.
 */
export async function buildCentraidMcpServer(
  mod: typeof import('@anthropic-ai/claude-agent-sdk'),
  ctx: ToolContext,
): Promise<unknown> {
  // Zod is a peer dep of the SDK; load lazily so non-Claude code paths
  // never pay the resolution cost.
  const { z } = await import('zod');

  const okText = (payload: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  });
  const errText = (msg: string) => ({
    content: [{ type: 'text' as const, text: msg }],
    isError: true,
  });

  const fromDispatch = (
    result: import('@centraid/app-engine').ToolResult,
  ): ReturnType<typeof okText> | ReturnType<typeof errText> => {
    if (result.isError) {
      const { code, message } = result.structuredContent;
      return errText(`[${code}] ${message}`);
    }
    return okText(result.structuredContent);
  };

  // The vault register: whole-vault SQL reads plus (when wired) typed
  // command writes — instead of the app-scoped trio.
  if (ctx.vaultSql) {
    const vaultSql = mod.tool(
      VAULT_SQL_TOOL.name,
      VAULT_SQL_TOOL.description,
      { sql: z.string().describe('One read-only statement: SELECT / WITH … SELECT / EXPLAIN.') },
      async ({ sql }) => {
        const out = await runVaultSqlTool(ctx, sql);
        return out.ok ? okText(out.result) : errText(out.errorText);
      },
    );
    const vaultInvoke = mod.tool(
      VAULT_INVOKE_TOOL.name,
      VAULT_INVOKE_TOOL.description,
      {
        command: z.string().describe('Registered command name.'),
        input: z.record(z.string(), z.unknown()).describe('Input matching the command schema.'),
      },
      async ({ command, input }) => {
        const out = await runVaultInvokeTool(ctx, { command, input });
        return out.ok ? okText(out.result) : errText(out.errorText);
      },
    );
    return mod.createSdkMcpServer({
      name: 'centraid',
      tools: ctx.vaultInvoke ? [vaultSql, vaultInvoke] : [vaultSql],
    });
  }

  const describe = mod.tool(
    'centraid_describe',
    "Return the app's manifest plus live SQLite schema, or a single declared handler entry. Call without arguments to see the full catalog; pass `action` or `query` to narrow. Use this before centraid_read/centraid_write to know what handlers exist and what input each accepts.",
    {
      action: z.string().optional().describe('Action name to narrow to.'),
      query: z.string().optional().describe('Query name to narrow to.'),
    },
    async ({ action, query }) => {
      try {
        return fromDispatch(
          await ctx.dispatcher.describe(
            {
              app: ctx.appId,
              ...(action ? { action } : {}),
              ...(query ? { query } : {}),
            },
            ctx.overrideCodeDir,
          ),
        );
      } catch (err) {
        return errText(err instanceof Error ? err.message : String(err));
      }
    },
  );

  const read = mod.tool(
    'centraid_read',
    'Invoke a declared query, or the `_sql` built-in for an ad-hoc SELECT. For declared queries set `query` to the name in the manifest and `input` to its JSON Schema shape. For ad-hoc reads use `query: "_sql"` and `input: { sql: "<single SELECT or EXPLAIN>" }` — rows capped at 200; DDL/PRAGMA refused. Prefer declared queries when one fits the user\'s ask.',
    {
      query: z.string().describe('Declared query name, or "_sql".'),
      input: z
        .unknown()
        .optional()
        .describe('Input matching the query schema, or { sql } for _sql.'),
    },
    async ({ query, input }) => {
      try {
        return fromDispatch(
          await ctx.dispatcher.read({ app: ctx.appId, query, input }, ctx.overrideCodeDir),
        );
      } catch (err) {
        return errText(err instanceof Error ? err.message : String(err));
      }
    },
  );

  const write = mod.tool(
    'centraid_write',
    'Invoke a declared action, or the `_sql` built-in for an ad-hoc INSERT/UPDATE/DELETE/REPLACE. For declared actions set `action` to the name in the manifest and `input` to its JSON Schema shape. For ad-hoc writes use `action: "_sql"` and `input: { sql: "<single statement>" }` — DDL/PRAGMA refused. Prefer declared actions when one fits the user\'s ask. The runtime fires its change bus after a successful write so the app UI re-renders automatically.',
    {
      action: z.string().describe('Declared action name, or "_sql".'),
      input: z
        .unknown()
        .optional()
        .describe('Input matching the action schema, or { sql } for _sql.'),
    },
    async ({ action, input }) => {
      try {
        return fromDispatch(
          await ctx.dispatcher.write({ app: ctx.appId, action, input }, ctx.overrideCodeDir),
        );
      } catch (err) {
        return errText(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return mod.createSdkMcpServer({ name: 'centraid', tools: [describe, read, write] });
}
