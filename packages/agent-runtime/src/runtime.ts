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

import type { ChatStreamEvent } from '@centraid/runtime-core';
import { runCodexAppServerTurn } from './codex-app-server.js';
import { runClaudeSdkTurn } from './claude-sdk.js';
import type { RunnerPrefs } from './types.js';

/**
 * Per-turn binding that lets adapters register the inline `centraid_sql_*`
 * tools and emit precise, provenanced change-bus events. Optional — when
 * absent (builder mode, tests), adapters fall back to no tool registration
 * and the legacy `centraid` CLI is the only SQL surface available.
 */
export interface ToolContext {
  /** Absolute path to the app's `data.sqlite` (the cwd's own data file). */
  dataFile: string;
  /**
   * Stable id for this single `runAgentTurn` invocation. Stamped on every
   * `centraid:datachange` event produced by tool calls inside this turn so
   * the chat UI can correlate iframe refreshes back to the chat pill.
   */
  agentTurnId: string;
  /**
   * Forward a precise change to the host's `ChangeBus`. The adapter calls
   * this after a successful `centraid_sql_write`. Emits no-op when `tables`
   * is empty.
   */
  emitChange: (payload: { tables: string[]; toolCallId?: string }) => void;
}

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
  /**
   * Inline-tool wiring. When present, the codex / claude adapters declare
   * the three `centraid_sql_*` tools and dispatch them in-process; without
   * it, the agent falls back to its generic shell tool. Chat callers always
   * supply one; builder callers (no per-app data file) omit it.
   */
  toolContext?: ToolContext;
  abortSignal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

export interface AgentTurnConfig {
  prefs: RunnerPrefs;
  /**
   * Parent directory under which scoped `CODEX_HOME`s are materialized
   * when `prefs.provider` is set on a codex runner. The host should
   * point this at a persistent location under its userData dir so codex
   * thread state survives across launches. Ignored for `claude-code`
   * runners. Defaults to `os.tmpdir()` inside the codex adapter.
   */
  codexHomeBaseDir?: string;
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
        ...(input.toolContext ? { toolContext: input.toolContext } : {}),
        abortSignal: input.abortSignal,
        onEvent: input.onEvent,
      },
      {
        ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
        ...(prefs.extraArgs?.length ? { extraArgs: prefs.extraArgs } : {}),
        ...(prefs.provider ? { provider: prefs.provider } : {}),
        ...(config.codexHomeBaseDir ? { codexHomeBaseDir: config.codexHomeBaseDir } : {}),
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
