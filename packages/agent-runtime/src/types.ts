/*
 * Shared types for the agent-runtime wrappers. The chat adapter
 * (`makeChatRunner`) and the builder agent session both read these; the
 * underlying backend primitives (`runCodexAppServerTurn` /
 * `runClaudeSdkTurn`) take their own neutral input shapes and don't
 * know about user prefs.
 */

export type RunnerKind = 'codex' | 'claude-code';

/**
 * OpenAI-compatible inference endpoint that the codex CLI should route
 * model calls through, instead of its default OpenAI-hosted models.
 * When set on a `codex` runner, the adapter materializes a per-provider
 * `CODEX_HOME` directory with a generated `config.toml`, and points the
 * spawned `codex` process at it via the `CODEX_HOME` env var. The user's
 * actual `~/.codex` is never touched.
 *
 * Covers Ollama, vLLM, Groq, Together, LM Studio, and anything else that
 * speaks `/v1/chat/completions` (or `/v1/responses` when `wireApi` is set).
 *
 * `claude-code` runners ignore this field — the Claude Agent SDK is
 * Anthropic-wire-format only.
 */
export interface OpenAICompatProvider {
  /** Slug used as the `[model_providers.<id>]` table key in config.toml. */
  id: string;
  /** Display name written into the toml's `name` field. */
  name: string;
  /** Base URL the endpoint exposes; must include `/v1` (or whatever path precedes `/chat/completions`). */
  baseUrl: string;
  /**
   * OpenAI wire format codex should use. `chat` = `/chat/completions`
   * (default, broadest support). `responses` = `/responses` (newer; some
   * providers proxy it).
   */
  wireApi?: 'chat' | 'responses';
  /**
   * Env var name codex will read for the bearer token. Omit for keyless
   * local servers (Ollama, LM Studio without auth).
   */
  envKey?: string;
  /**
   * API key value. Injected only into the spawned codex process's env
   * under `envKey` — never written to the toml, never mutated onto the
   * host's `process.env`. Required when `envKey` is set.
   */
  apiKey?: string;
}

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
  /**
   * When set and `kind === 'codex'`, the spawned codex CLI is configured
   * via a scoped `CODEX_HOME` to route model requests through this
   * OpenAI-compatible endpoint. Ignored when `kind === 'claude-code'`.
   */
  provider?: OpenAICompatProvider;
}
