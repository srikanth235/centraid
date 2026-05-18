/*
 * Shared types for the agent-runtime wrappers. The chat adapter
 * (`makeChatRunner`) and the builder agent session both read these; the
 * underlying backend primitives (`runCodexAppServerTurn` /
 * `runClaudeSdkTurn`) take their own neutral input shapes and don't
 * know about user prefs.
 */

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
