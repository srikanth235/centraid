/*
 * Shared types for the local chat-runner wrapper. Only the wrapper
 * (`makeLocalChatRunner`) reads these — the underlying CLI primitives
 * (`runCodexTurn` / `runClaudeTurn`) take their own neutral input
 * shapes and don't know about user prefs.
 */

export type RunnerKind = 'codex' | 'claude-code';

/**
 * Per-user settings for the local runtime's chat runner. Persisted by the
 * desktop's UserStore (gateway DB, `user_prefs`) under the `chat.runner.*`
 * keys. The host loads + passes them into `makeLocalChatRunner`.
 */
export interface RunnerPrefs {
  /** Which CLI to invoke. Required when the desktop is in local-runtime mode. */
  kind: RunnerKind;
  /** Override the binary location; defaults to PATH lookup. */
  binPath?: string;
  /** Extra args passed verbatim to the CLI invocation. */
  extraArgs?: string[];
}
