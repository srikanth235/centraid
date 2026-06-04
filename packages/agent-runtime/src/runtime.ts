/*
 * Unified agent-turn primitive.
 *
 * Both chat and builder share this entry point. It dispatches to one of
 * two backends based on the user's persisted `agent.runner.kind` pref:
 *
 *   - `codex`       → spawn `codex app-server` (JSON-RPC stdio)
 *   - `claude-code` → call `@anthropic-ai/claude-agent-sdk`'s `query()` in-process
 *
 * Both backends emit the same `TurnStreamEvent` shape, so callers don't
 * need to know which one ran a given turn. The returned `adapterSessionId`
 * (codex thread id / claude session id) is opaque — round-trip it on the
 * next turn via `prevSessionId` to resume the conversation.
 */

import type { TurnConfig, TurnInput, TurnResult } from '@centraid/app-engine';
import { runCodexAppServerTurn } from './backends/codex-app-server.js';
import { runClaudeSdkTurn } from './backends/claude-sdk.js';

// The turn-driver contract (`ToolContext`, `TurnInput/Config/Result`)
// now lives in `@centraid/app-engine` so the backend-agnostic run engine can
// speak it. Re-exported here so this package's modules + back-compat
// consumers keep importing them from `@centraid/agent-runtime`.
export type { ToolContext, TurnInput, TurnConfig, TurnResult } from '@centraid/app-engine';

export async function runTurn(input: TurnInput, config: TurnConfig): Promise<TurnResult> {
  const { prefs } = config;

  if (prefs.kind === 'codex') {
    const result = await runCodexAppServerTurn(
      {
        cwd: input.cwd,
        message: input.message,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
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
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
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
