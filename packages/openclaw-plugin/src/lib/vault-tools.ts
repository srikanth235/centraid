/*
 * Vault-register tools for the OpenClaw embedded turn (issue #319, WS3).
 *
 * The per-app chat endpoint (`POST /centraid/<appId>/_turn`) drives OpenClaw's
 * embedded agent (`openclaw-conversation-runner.ts`). Those turns carried NO
 * data tools once the per-app silo died (#286) — the agent could talk but not
 * touch the vault. This module gives them the SAME three tools the codex /
 * claude runners get, executed IN-PROCESS through the gateway's owner-side
 * consent/receipt pipeline:
 *
 *   - `vault_sql`     — one read-only SQL statement over the whole vault.
 *   - `vault_invoke`  — one typed vault command (the write path; Tier 3/4
 *                       commands park for the owner instead of executing).
 *   - `vault_content` — the extracted text of one document/content item.
 *
 * These are NOT `clientTools` on `runEmbeddedAgent` — that param defers
 * fulfillment to an out-of-band OpenResponses client (the tool "executes" by
 * returning a `status: pending` stub and the run yields), which is the wrong
 * shape for synchronous in-process execution. Instead we use `api.registerTool`
 * with a FACTORY keyed on `ctx.sessionKey`: the tools are returned ONLY for a
 * centraid conversation session (`centraid-conversation:<appId>:…`), so they
 * never pollute the user's own OpenClaw agent's tool list, and they resolve the
 * request's ACTIVE vault at call time via the gateway's per-request vault scope
 * (issue #289) — the same `makeVaultToolRunners` thunks the CLI runners use.
 */

import { Type } from 'typebox';
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import { VAULT_SQL_TOOL, VAULT_INVOKE_TOOL, VAULT_CONTENT_TOOL } from '@centraid/agent-runtime';
import { makeVaultToolRunners, type VaultRegistry } from '@centraid/gateway';

/** Chat session-key prefix the per-app runner opens with. */
export const SESSION_PREFIX = 'centraid-conversation:';

/**
 * True when a session key belongs to a centraid conversation turn. OpenClaw
 * prefixes stored session keys with `agent:<agentId>:`, so the marker is a
 * substring (`agent:main:centraid-conversation:todos:w1`), not a prefix.
 */
export function isCentraidConversationSession(sessionKey: string | undefined): boolean {
  return typeof sessionKey === 'string' && sessionKey.includes(SESSION_PREFIX);
}

/** Wrap a JSON-serializable payload as an agent tool result. */
function jsonToolResult(payload: unknown): Awaited<ReturnType<AnyAgentTool['execute']>> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload ?? null) }],
    details: payload,
  };
}

/**
 * Register the three vault-register tools with the OpenClaw host, scoped to
 * centraid conversation sessions. `vaultRegistryReady` resolves once the
 * gateway core is built (the plugin can't hand a registry at construction —
 * the runner is injected INTO `buildGateway`); the tools await it lazily on
 * first call. The runner thunks resolve `vaults.current()` per call, so every
 * tool run hits the request's active vault.
 */
export function registerVaultTools(
  api: OpenClawPluginApi,
  vaultRegistryReady: Promise<VaultRegistry>,
): void {
  // Memoize the thunk bundle once the registry resolves; each thunk still
  // re-resolves the active vault plane per call.
  let runnersPromise: Promise<ReturnType<typeof makeVaultToolRunners>> | undefined;
  const ensureRunners = (): Promise<ReturnType<typeof makeVaultToolRunners>> => {
    if (!runnersPromise) {
      runnersPromise = vaultRegistryReady.then((vaults) => makeVaultToolRunners(vaults));
    }
    return runnersPromise;
  };

  const sqlTool: AnyAgentTool = {
    name: VAULT_SQL_TOOL.name,
    label: 'Vault: read-only SQL',
    description: VAULT_SQL_TOOL.description,
    parameters: Type.Object({
      sql: Type.String({
        description: 'One read-only statement: SELECT / WITH … SELECT / EXPLAIN.',
      }),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const sql = (params as { sql?: unknown })?.sql;
      if (typeof sql !== 'string' || sql.trim() === '') {
        throw new Error('vault_sql requires { sql: "<single read-only statement>" }');
      }
      const runners = await ensureRunners();
      return jsonToolResult(await runners.vaultSql()(sql));
    },
  };

  const invokeTool: AnyAgentTool = {
    name: VAULT_INVOKE_TOOL.name,
    label: 'Vault: invoke command',
    description: VAULT_INVOKE_TOOL.description,
    parameters: Type.Object({
      command: Type.String({
        description: 'Registered command name, e.g. schedule.propose_event.',
      }),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: 'Input matching the command schema.',
        }),
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const p = (params ?? {}) as { command?: unknown; input?: unknown };
      if (typeof p.command !== 'string' || p.command.trim() === '') {
        throw new Error('vault_invoke requires { command, input }');
      }
      const input =
        p.input && typeof p.input === 'object' && !Array.isArray(p.input)
          ? (p.input as Record<string, unknown>)
          : {};
      const runners = await ensureRunners();
      return jsonToolResult(await runners.vaultInvoke()({ command: p.command, input }));
    },
  };

  const contentTool: AnyAgentTool = {
    name: VAULT_CONTENT_TOOL.name,
    label: 'Vault: read document text',
    description: VAULT_CONTENT_TOOL.description,
    parameters: Type.Object({
      content_id: Type.String({ description: 'core_content_item.content_id to read.' }),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const contentId = (params as { content_id?: unknown })?.content_id;
      if (typeof contentId !== 'string' || contentId.trim() === '') {
        throw new Error('vault_content requires { content_id }');
      }
      const runners = await ensureRunners();
      return jsonToolResult(await runners.vaultContent()({ contentId }));
    },
  };

  const vaultTools = [sqlTool, invokeTool, contentTool];

  // Factory form: OpenClaw invokes it per run with the run's tool context.
  // Return the vault tools ONLY for centraid conversation sessions — the
  // user's own agent runs get `null`, so vault_* never appears in its tool
  // list (nor could it reach another vault: the runners resolve the request's
  // active vault, and a non-centraid run has no such request scope).
  api.registerTool((ctx: OpenClawPluginToolContext): AnyAgentTool[] | null =>
    isCentraidConversationSession(ctx.sessionKey) ? vaultTools : null,
  );
}
