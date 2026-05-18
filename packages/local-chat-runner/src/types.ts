/*
 * Shared types for the local chat-runner. Kept minimal — adapter
 * implementations import what they need, the dispatcher reads only
 * `RunnerPrefs`.
 */

import type { ChatRunInput } from '@centraid/runtime-core';

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

/**
 * Construction-time options every adapter receives. The `appsDir` is the
 * embedded local runtime's apps directory — same one the runtime constructs
 * its `Registry` against. The MCP server reuses it to compute the
 * `<appsDir>/<appId>/data.sqlite` path for each tool call.
 */
export interface AdapterCtx {
  appsDir: string;
  /** Absolute path to the built `centraid-mcp-server.js` entrypoint. */
  mcpServerScript: string;
  /** Node binary used to spawn the MCP server. Defaults to `process.execPath`. */
  nodeBin?: string;
  /** Forwarded CLI-specific user prefs. */
  prefs: RunnerPrefs;
}

export interface RunOneTurnArgs {
  ctx: AdapterCtx;
  input: ChatRunInput;
}
