/*
 * Unified agent-turn primitive.
 *
 * Both chat and builder share this entry point. It dispatches to one of
 * three backends based on the user's persisted `agent.runner.kind` pref:
 *
 *   - `codex`       → spawn `codex app-server` (JSON-RPC stdio)
 *   - `claude-code` → call `@anthropic-ai/claude-agent-sdk`'s `query()` in-process
 *   - `openclaw`    → spawn `openclaw acp` (Agent Client Protocol stdio)
 *
 * All backends emit the same `ChatStreamEvent` shape, so callers don't
 * need to know which one ran a given turn. The returned `adapterSessionId`
 * (codex thread id / claude session id) is opaque — round-trip it on the
 * next turn via `prevSessionId` to resume the conversation.
 *
 * When `prefs.provider` is set on a codex runner, the codex CLI is
 * pointed at an OpenAI-compatible endpoint (Ollama, Groq, vLLM, …) via
 * a scoped `CODEX_HOME`. The dispatcher just plumbs the prefs through;
 * see `codex-app-server.ts` for the toml materialization.
 */

import type { ChatStreamEvent, Dispatcher } from '@centraid/app-engine';
import { runCodexAppServerTurn } from './codex-app-server.js';
import { runClaudeSdkTurn } from './claude-sdk.js';
import { runOpenClawAcpTurn } from './openclaw-acp.js';
import type { RunnerPrefs } from './types.js';

/**
 * Per-turn binding that lets adapters register the three structured
 * centraid tools (`centraid_describe`, `centraid_read`, `centraid_write`)
 * and emit precise, provenanced change-bus events. Optional — when
 * absent (builder mode, tests), adapters fall back to no tool registration
 * and the legacy `centraid` CLI is the only SQL surface available.
 */
export interface ToolContext {
  /**
   * App id this turn is scoped to. Threaded through the structured tool
   * dispatch so the tools auto-fill `app` and refuse cross-app calls.
   */
  appId: string;
  /**
   * Shared three-tool dispatcher. Tool calls route here; built-in `_sql`
   * is handled inside the dispatcher against the app's own `data.sqlite`.
   */
  dispatcher: Dispatcher;
  /**
   * Stable id for this single `runAgentTurn` invocation. Stamped on every
   * `centraid:datachange` event produced by tool calls inside this turn so
   * the chat UI can correlate iframe refreshes back to the chat pill.
   */
  agentTurnId: string;
  /**
   * Draft code dir for this turn — the session worktree's `apps/<id>/`
   * (issue #144). When set, the dispatcher serves the draft's handlers AND
   * its branched `data.sqlite` (data dir = code dir in draft mode), so the
   * agent authoring a migration can exercise it against prod-seeded draft
   * data without touching live rows. Absent on the data-only chat backend.
   */
  overrideCodeDir?: string;
}

export interface AgentTurnInput {
  /** Working directory the agent operates in (chat: app data dir; builder: app dir). */
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

  if (prefs.kind === 'openclaw') {
    // openclaw reaches centraid data via the bundled `centraid` CLI on
    // PATH (its shell tool), not via the inline `toolContext` dispatcher —
    // so `toolContext` is intentionally not forwarded here.
    const result = await runOpenClawAcpTurn(
      {
        cwd: input.cwd,
        message: input.message,
        extraSystemPrompt: input.extraSystemPrompt,
        ...(input.model ? { model: input.model } : {}),
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
      adapterKind: 'openclaw',
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
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
