/*
 * Agent-turn contract — the host-agnostic interface between a run spine and
 * the backend that actually drives one model turn.
 *
 * These types used to live in `@centraid/agent-runtime` (the local
 * codex/claude backend). They moved down here so the backend-agnostic run
 * engine (`makeChatRunnerCore`, the automation fire spine) can speak the
 * turn contract without depending on any agent backend — agent-runtime,
 * the gateway, and openclaw all inject a concrete `RunTurnFn` that satisfies
 * it. The interface lives here next to `ChatRunner`; the codex/claude
 * implementation (`runAgentTurn`) stays in agent-runtime.
 */

import type { ChatStreamEvent } from './chat-runner.js';
import type { Dispatcher } from './dispatcher.js';

export type RunnerKind = 'codex' | 'claude-code';

/**
 * Per-user settings for the coding agent. Persisted by the desktop's
 * UserStore (gateway DB, `user_prefs`) under the `agent.runner.*` keys.
 * The host loads + passes these into `makeChatRunner` (for chat) or
 * directly into `runAgentTurn` (for builder).
 */
export interface RunnerPrefs {
  /** Which CLI/SDK to invoke. Required when the desktop is in local-runtime mode. */
  kind: RunnerKind;
  /** Override the binary location; defaults to PATH lookup. */
  binPath?: string;
  /** Extra args passed verbatim to the CLI invocation. */
  extraArgs?: string[];
}

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
}

export interface AgentTurnResult {
  /** Codex thread id (when `prefs.kind === 'codex'`) or Claude session id. */
  sessionId?: string;
  /** Echoes the runner kind that produced `sessionId`. */
  adapterKind: RunnerPrefs['kind'];
}

/**
 * The thin turn-driver the run engine depends on. agent-runtime's
 * `runAgentTurn` is the production implementation; tests inject a stub.
 * Kept structural (not `typeof runAgentTurn`) so this layer never imports
 * the codex/claude backend.
 */
export type RunTurnFn = (
  input: AgentTurnInput,
  config: AgentTurnConfig,
) => Promise<AgentTurnResult>;
