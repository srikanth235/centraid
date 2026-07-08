/*
 * OpenClaw `ConversationRunner` implementation.
 *
 * Wraps `api.runtime.agent.runEmbeddedAgent` so the per-app chat endpoint
 * (`POST /centraid/<appId>/_turn`) drives the same in-process embedded
 * agent that powers everything else in the gateway. Centraid does NOT
 * register its own agent identity here:
 *
 *   - `isCanonicalWorkspace: false` plus a plugin-owned `workspaceDir`
 *     gives `bootstrapMode = "limited"` — AGENTS.md / SOUL.md / USER.md
 *     loading is skipped. We don't pretend to be the user's main agent.
 *   - No `agentId` override; OpenClaw falls back to its default (`"main"`)
 *     so model resolution + tool policy follow the user's existing config.
 *
 * Streaming translation maps OpenClaw's callbacks onto `TurnStreamEvent`s:
 *   onAssistantMessageStart → { type: 'assistant.start' }
 *   onBlockReply (text=...)  → { type: 'assistant.delta' | 'reasoning.delta' }
 *   onReasoningStream        → { type: 'reasoning.delta' }
 *   onAgentEvent (stream:tool) → { type: 'tool.start' | 'tool.result' }
 *
 * Tool trace fidelity (issue #319, workstream 1). Both `tool.start` and
 * `tool.result` are driven off the **always-on** `onAgentEvent` stream
 * (`stream: "tool"`, discriminated by `data.phase`), NOT the `onToolResult`
 * callback (which only fires under `verboseLevel: on|full`, so it emitted
 * nothing by default) nor the stale `tool_execution_start` pattern-match
 * (OpenClaw's real stream name is just `"tool"`, so the old match never
 * fired). The agent-event stream carries the authoritative `toolCallId` +
 * tool `name` + `isError`, so the trace now records real tool names and the
 * harness pairs each result to its start. The sanitized observation stream
 * omits the raw result body, so `tool.result` carries name + ok, not the
 * tool's full output — an acceptable trade for correctness + always-on.
 *
 * Turn accounting (issue #319, workstream 1). After the run settles we emit a
 * single `usage` `TurnStreamEvent` from `result.meta.agentMeta` (provider,
 * model, input/output/cache tokens) so cost/insights fold OpenClaw chat turns
 * into the unified ledger like codex/claude turns.
 */

import path from 'node:path';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type {
  ConversationRunner,
  ConversationTurnInput,
  TurnStreamEvent,
} from '@centraid/app-engine';
import { buildVaultToolsGrounding, type VaultRegistry } from '@centraid/gateway';
import { runEmbeddedTurn, type EmbeddedResult } from './openclaw-agent-turn.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Construct a `ConversationRunner` bound to the OpenClaw plugin api. The runner is
 * stateless — every `run()` call resolves an independent agent run.
 *
 * `vaultRegistryReady` resolves once the gateway core is built (the runner is
 * injected INTO `buildGateway`, so it can't hold the registry at construction).
 * Each turn resolves the request's ACTIVE vault through it to append the
 * vault-register grounding (schema map + how to use `vault_sql` / `vault_invoke`
 * / `vault_content`) — the tools themselves are host-registered per session
 * (`vault-tools.ts`); without the grounding the agent would have the tools but
 * not know the vault's shape (issue #319, WS3).
 */
export function makeOpenClawConversationRunner(
  api: OpenClawPluginApi,
  vaultRegistryReady: Promise<VaultRegistry>,
): ConversationRunner {
  return {
    async run(input: ConversationTurnInput): Promise<void> {
      const sessionKey = `centraid-conversation:${input.appId}:w${input.conversationId}`;
      const sessionId = sessionKey;
      const runId = `centraid:${input.appId}:${input.conversationId}:${Date.now().toString(36)}`;

      // Plugin-owned scratch dir plus `isCanonicalWorkspace=false` so
      // OpenClaw skips AGENTS.md / SOUL.md / USER.md loading; the user's
      // agent persona still drives tool-policy resolution because agentId
      // is unset (defaults to main).
      //
      // Per-vault disposable location (issue #319, workstream 2): derived
      // from the runner-session dir (`path.dirname(sessionFile)` — the ACTIVE
      // vault's `runner-sessions/`), NOT `os.homedir()`. The old
      // `~/.openclaw/centraid/_conversation-workspace` was a single dir shared
      // by every vault's turns; scoping it under the vault keeps one vault's
      // scratch out of another's and makes it safe to wipe with the vault.
      const workspaceDir = path.join(path.dirname(input.sessionFile), '_conversation-workspace');

      const emit = (event: TurnStreamEvent): void => {
        if (input.abortSignal.aborted) return;
        input.onEvent(event);
      };

      // Append the vault-register grounding to the route's app-context
      // preamble so the host-registered `vault_*` tools are usable (the app
      // prompt names no vault schema — it defers that to whoever wires the
      // tools). Resolve the request's active vault; on any failure keep the
      // bare preamble rather than fail the turn.
      let extraSystemPrompt = input.extraSystemPrompt;
      try {
        const plane = (await vaultRegistryReady).current();
        const grounding = buildVaultToolsGrounding(plane.name, plane.assistantContext());
        extraSystemPrompt = extraSystemPrompt ? `${extraSystemPrompt}\n\n${grounding}` : grounding;
      } catch {
        /* grounding is best-effort — the tools still execute without it */
      }

      try {
        // `runEmbeddedTurn` applies the centraid defaults `isCanonicalWorkspace:
        // false` (→ bootstrapMode "limited", so AGENTS.md / SOUL.md / USER.md
        // loading is skipped) and `promptMode: 'full'`.
        const result = await runEmbeddedTurn(api, {
          sessionId,
          sessionKey,
          sessionFile: input.sessionFile,
          workspaceDir,
          prompt: input.message,
          extraSystemPrompt,
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinking
            ? { thinkLevel: input.thinking as 'low' | 'medium' | 'high' | 'off' }
            : {}),
          trigger: 'user',
          abortSignal: input.abortSignal,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          runId,

          onAssistantMessageStart: () => {
            emit({ type: 'assistant.start' });
          },
          onBlockReply: (payload) => {
            if (payload.isReasoning) {
              if (payload.text) emit({ type: 'reasoning.delta', delta: payload.text });
              return;
            }
            if (payload.text) emit({ type: 'assistant.delta', delta: payload.text });
          },
          onReasoningStream: (payload) => {
            if (payload.text) emit({ type: 'reasoning.delta', delta: payload.text });
          },
          onAgentEvent: (evt) => {
            try {
              translateAgentEvent(evt, emit);
            } catch {
              // Translation failures are non-fatal — they're just diagnostic
              // pass-throughs.
            }
          },
        });

        // Fold the turn's token totals into the ledger (issue #319, WS1).
        const usage = usageEventFromResult(result);
        if (usage) emit(usage);

        // OpenClaw's run resolves with a result blob; we don't surface it
        // separately. The harness already saw the final assistant text via
        // onBlockReply. Emit a `final` marker so the harness can flush.
        emit({ type: 'final', text: '' });
      } catch (err) {
        if (input.abortSignal.aborted) {
          emit({ type: 'aborted' });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'error', message });
        throw err;
      }
    },
  };
}

/**
 * Build a `usage` `TurnStreamEvent` from a finished embedded run's metadata,
 * or `undefined` when the run reported no usable accounting. The accumulated
 * `usage` (summed across the run's model calls) is the turn total the cost
 * ledger wants — not `lastCallUsage` (the final call's context snapshot).
 */
function usageEventFromResult(result: EmbeddedResult): TurnStreamEvent | undefined {
  const meta = result.meta?.agentMeta;
  if (!meta) return undefined;
  const u = meta.usage;
  const event: Extract<TurnStreamEvent, { type: 'usage' }> = {
    type: 'usage',
    ...(meta.model ? { model: meta.model } : {}),
    ...(meta.provider ? { provider: meta.provider } : {}),
    ...(typeof u?.input === 'number' ? { inputTokens: u.input } : {}),
    ...(typeof u?.output === 'number' ? { outputTokens: u.output } : {}),
    ...(typeof u?.cacheRead === 'number' ? { cacheReadTokens: u.cacheRead } : {}),
    ...(typeof u?.cacheWrite === 'number' ? { cacheWriteTokens: u.cacheWrite } : {}),
  };
  // Nothing beyond the discriminant → not worth a ledger fold.
  if (Object.keys(event).length <= 1) return undefined;
  return event;
}

/**
 * Translate one entry from OpenClaw's generic agent-event stream into a
 * `TurnStreamEvent`.
 *
 * The tool lifecycle rides `stream: "tool"`, discriminated by `data.phase`
 * (`start` | `update` | `result`) — the always-on source of truth for tool
 * calls (see the file header). We surface `start` and `result`; `update`
 * (streaming partials) is dropped to keep the trace lean. Everything else
 * (plan, compaction, …) passes through as a `phase` event the harness can
 * show or ignore.
 */
function translateAgentEvent(
  evt: { stream: string; data: Record<string, unknown> },
  emit: (e: TurnStreamEvent) => void,
): void {
  const stream = evt.stream;
  const data = evt.data ?? {};

  if (stream === 'tool') {
    const phase = typeof data.phase === 'string' ? data.phase : '';
    const toolCallId = String((data.toolCallId ?? data.id ?? '') || '');
    const toolName = String((data.name ?? data.toolName ?? 'tool') || 'tool');

    if (phase === 'start') {
      const args = (data.args ?? data.params ?? data.arguments) as
        | Record<string, unknown>
        | undefined;
      const sql =
        args && typeof args === 'object' && typeof args.sql === 'string'
          ? (args.sql as string)
          : undefined;
      emit({
        type: 'tool.start',
        toolCallId: toolCallId || `oc-tool-${toolName}`,
        toolName,
        ...(args ? { args } : {}),
        ...(sql ? { sql } : {}),
      });
      return;
    }
    if (phase === 'result') {
      const isError = data.isError === true;
      emit({
        type: 'tool.result',
        toolCallId: toolCallId || `oc-tool-${toolName}`,
        toolName,
        ok: !isError,
      });
      return;
    }
    // `update` (partial results) — skip.
    return;
  }

  // Anything else gets surfaced as a generic phase so the harness can show
  // it (or ignore it) without us trying to enumerate every OpenClaw stream.
  emit({ type: 'phase', phase: stream, detail: data });
}
