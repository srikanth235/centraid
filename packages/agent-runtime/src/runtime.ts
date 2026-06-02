/*
 * Unified agent-turn primitive.
 *
 * Both chat and builder share this entry point. It dispatches to one of
 * two backends based on the user's persisted `agent.runner.kind` pref:
 *
 *   - `codex`       → spawn `codex app-server` (JSON-RPC stdio)
 *   - `claude-code` → call `@anthropic-ai/claude-agent-sdk`'s `query()` in-process
 *
 * Both backends emit the same `ChatStreamEvent` shape, so callers don't
 * need to know which one ran a given turn. The returned `adapterSessionId`
 * (codex thread id / claude session id) is opaque — round-trip it on the
 * next turn via `prevSessionId` to resume the conversation.
 *
 * When `prefs.provider` is set on a codex runner, the codex CLI is
 * pointed at an OpenAI-compatible endpoint (Ollama, Groq, vLLM, …) via
 * a scoped `CODEX_HOME`. The dispatcher just plumbs the prefs through;
 * see `codex-app-server.ts` for the toml materialization.
 */

import type { AgentTurnConfig, AgentTurnInput, AgentTurnResult } from '@centraid/app-engine';
import { runCodexAppServerTurn } from './codex-app-server.js';
import { runClaudeSdkTurn } from './claude-sdk.js';

// The agent-turn contract (`ToolContext`, `AgentTurnInput/Config/Result`)
// now lives in `@centraid/app-engine` so the backend-agnostic run engine can
// speak it. Re-exported here so this package's modules + back-compat
// consumers keep importing them from `@centraid/agent-runtime`.
export type {
  ToolContext,
  AgentTurnInput,
  AgentTurnConfig,
  AgentTurnResult,
} from '@centraid/app-engine';

export async function runAgentTurn(
  input: AgentTurnInput,
  config: AgentTurnConfig,
): Promise<AgentTurnResult> {
  const { prefs } = config;

  if (prefs.kind === 'codex') {
    const result = await runCodexAppServerTurn(
      {
        cwd: input.cwd,
        message: input.message,
        extraSystemPrompt: input.extraSystemPrompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.prevSessionId ? { prevThreadId: input.prevSessionId } : {}),
        ...(input.extraPath ? { extraPath: input.extraPath } : {}),
        ...(input.toolContext ? { toolContext: input.toolContext } : {}),
        abortSignal: input.abortSignal,
        onEvent: input.onEvent,
      },
      {
        ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
        ...(prefs.extraArgs?.length ? { extraArgs: prefs.extraArgs } : {}),
        ...(prefs.provider ? { provider: prefs.provider } : {}),
      },
    );
    return {
      adapterKind: 'codex',
      ...(result.threadId ? { sessionId: result.threadId } : {}),
    };
  }

  const result = await runClaudeSdkTurn(
    {
      cwd: input.cwd,
      message: input.message,
      extraSystemPrompt: input.extraSystemPrompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.prevSessionId ? { prevSessionId: input.prevSessionId } : {}),
      ...(input.extraPath ? { extraPath: input.extraPath } : {}),
      ...(input.toolContext ? { toolContext: input.toolContext } : {}),
      abortSignal: input.abortSignal,
      onEvent: input.onEvent,
    },
    prefs.binPath ? { pathToClaudeCodeExecutable: prefs.binPath } : {},
  );
  return {
    adapterKind: 'claude-code',
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  };
}
