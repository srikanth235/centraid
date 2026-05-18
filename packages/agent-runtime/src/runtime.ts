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
 */

import type { ChatStreamEvent } from '@centraid/runtime-core';
import { runCodexAppServerTurn } from './codex-app-server.js';
import { runClaudeSdkTurn } from './claude-sdk.js';
import type { RunnerPrefs } from './types.js';

export interface AgentTurnInput {
  /** Working directory the agent operates in (chat: app data dir; builder: project dir). */
  cwd: string;
  message: string;
  /** Backend-specific append point: codex `developerInstructions` / claude `systemPrompt.append`. */
  extraSystemPrompt: string;
  model?: string;
  /** Resume id from a prior turn (codex thread id / claude session id). */
  prevSessionId?: string;
  /**
   * Directories to prepend to PATH for any subprocess the agent spawns
   * (codex's shell tool, claude's Bash tool). Path-delimited string —
   * `path.delimiter` between entries. Used to expose the `centraid` CLI
   * without mutating the host's `process.env` (which would race between
   * concurrent turns). Empty / undefined = no PATH override.
   */
  extraPath?: string;
  abortSignal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

export interface AgentTurnConfig {
  prefs: RunnerPrefs;
}

export interface AgentTurnResult {
  /** Codex thread id (when `prefs.kind === 'codex'`) or Claude session id. */
  sessionId?: string;
  /** Echoes the runner kind that produced `sessionId`. */
  adapterKind: RunnerPrefs['kind'];
}

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
      extraSystemPrompt: input.extraSystemPrompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.prevSessionId ? { prevSessionId: input.prevSessionId } : {}),
      ...(input.extraPath ? { extraPath: input.extraPath } : {}),
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
