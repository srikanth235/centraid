/*
 * Claude-side wiring for the vault-register tools — the ONE tool family
 * (issue #286 phase 2). The pre-vault `centraid_describe/read/write` trio
 * died with the per-app data.sqlite: every register that touches data now
 * rides `vault_sql` (owner-side read-only SQL over the whole vault) and
 * `vault_invoke` (typed commands, high-risk parks). The host threads the
 * runners in per turn via `ToolContext.vaultSql` / `vaultInvoke`; a turn
 * without them (no vault mounted) simply has no data tools.
 *
 * This module owns the in-process MCP server, mirroring codex's
 * `host-tools.ts`; names/descriptions/dispatch are shared through
 * `vault-sql-tool.ts` so the model sees an identical surface across
 * backends.
 */
import type { ToolContext } from '../../runtime.js';
import {
  VAULT_CONTENT_TOOL,
  VAULT_INVOKE_TOOL,
  VAULT_SQL_TOOL,
  runVaultContentTool,
  runVaultInvokeTool,
  runVaultSqlTool,
} from '../../vault-sql-tool.js';

/**
 * Build the in-process MCP server exposing the vault-register tools, or
 * `undefined` when the turn carries no vault runner. Zod 4 is the
 * project's pinned schema lib; the SDK accepts both Zod 3 and Zod 4.
 */
export async function buildCentraidMcpServer(
  mod: typeof import('@anthropic-ai/claude-agent-sdk'),
  ctx: ToolContext,
): Promise<unknown | undefined> {
  if (!ctx.vaultSql) return undefined;
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
  const vaultContent = mod.tool(
    VAULT_CONTENT_TOOL.name,
    VAULT_CONTENT_TOOL.description,
    { content_id: z.string().describe('core_content_item.content_id to read.') },
    async ({ content_id }) => {
      const out = await runVaultContentTool(ctx, { content_id });
      return out.ok ? okText(out.result) : errText(out.errorText);
    },
  );
  return mod.createSdkMcpServer({
    name: 'centraid',
    tools: [
      vaultSql,
      ...(ctx.vaultInvoke ? [vaultInvoke] : []),
      ...(ctx.vaultContent ? [vaultContent] : []),
    ],
  });
}
