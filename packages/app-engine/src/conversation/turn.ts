/*
 * Turn-driver contract — the host-agnostic interface between a run spine and
 * the backend that actually drives one model turn.
 *
 * These types used to live in `@centraid/agent-runtime` (the local
 * codex/claude backend). They moved down here so the backend-agnostic run
 * engine (`makeConversationRunnerCore`, the automation fire spine) can speak the
 * turn contract without depending on any agent backend — agent-runtime and
 * the gateway both inject a concrete `RunTurnFn` that satisfies it. The
 * interface lives here next to `ConversationRunner`; the codex/claude
 * implementation (`runTurn`) stays in agent-runtime.
 */

import type { TurnStreamEvent } from './runner.js';
import type { Dispatcher } from '../handlers/dispatcher.js';

/**
 * Every runner kind the runtime knows how to drive — the single
 * source of truth. Since issue #479 they all share one transport, the
 * generic ACP (Agent Client Protocol) harness: `gemini`, `qwen`,
 * `opencode`, `grok` and `kimi` speak ACP natively, while `codex` and
 * `claude-code` reach it through their first-party adapters. `acp` is
 * the escape hatch for any other ACP-speaking CLI, configured entirely
 * through `RunnerPrefs` (`binPath` + `extraArgs` supply the binary and
 * its ACP flag).
 *
 * agent-runtime owns a `RunnerBackend` registry keyed on these values;
 * add a kind here and register its backend there — nothing switches on
 * a hardcoded per-kind literal anymore.
 */
export const RUNNER_KINDS = [
  'codex',
  'claude-code',
  'gemini',
  'qwen',
  'opencode',
  'grok',
  'kimi',
  'copilot',
  'cursor',
  'kilo',
  'cline',
  'goose',
  'auggie',
  'vibe',
  'droid',
  'pi',
  'acp',
] as const;

export type RunnerKind = (typeof RUNNER_KINDS)[number];

/** Validation guard for persisted/wire strings that claim to be a runner kind. */
export function isRunnerKind(value: unknown): value is RunnerKind {
  return typeof value === 'string' && (RUNNER_KINDS as readonly string[]).includes(value);
}

/**
 * Per-user settings for the coding agent. Persisted by the desktop's
 * UserStore (gateway DB, `user_prefs`) under the `agent.runner.*` keys.
 * The host loads + passes these into `makeConversationRunner` (for chat) or
 * directly into `runTurn` (for builder).
 */
export interface RunnerPrefs {
  /** Which CLI/SDK to invoke. Required when the desktop is in local-runtime mode. */
  kind: RunnerKind;
  /** Override the binary location; defaults to PATH lookup. */
  binPath?: string;
  /** Extra args passed verbatim to the CLI invocation. */
  extraArgs?: string[];
}

/** What one `vault_sql` tool call returns to the model (rows + caps). */
export interface VaultSqlToolResult {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  truncated: boolean;
  durationMs: number;
}

/**
 * The vault assistant's read tool: one read-only SELECT over the ACTIVE
 * vault's whole canonical model. The gateway threads an owner-credentialed
 * runner in here; a refused/broken statement throws with the message the
 * model needs to self-correct.
 */
export type VaultSqlRunner = (sql: string) => Promise<VaultSqlToolResult> | VaultSqlToolResult;

/**
 * The vault assistant's write tool (issue #286 phase 2): one typed vault
 * command. The gateway executes it as the enrolled `_assistant` agent, so
 * high-risk commands PARK for owner confirmation — the returned outcome
 * (`executed` / `parked` / `denied` / `failed`) is handed back to the
 * model verbatim so it can relay what happened.
 */
export type VaultInvokeRunner = (call: {
  command: string;
  input: Record<string, unknown>;
}) => Promise<unknown> | unknown;

/**
 * The vault assistant's content tool (issue #299): the extracted text /
 * inline body of one content item, size-bounded and receipted — how "walk
 * me through this contract" reads the document without unbounded bytes
 * leaving custody. Text-first by design: binary variants stay on the
 * enricher plane.
 */
export type VaultContentRunner = (call: { contentId: string }) => Promise<unknown> | unknown;

/**
 * Per-turn binding that lets adapters register the vault-register tools
 * (`vault_sql` / `vault_invoke`, when the runners below are threaded in)
 * and emit provenanced change-bus events. Optional — when absent (tests),
 * adapters register no data tools.
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
   * Stable id for this single `runTurn` invocation. Stamped on every
   * `centraid:datachange` event produced by tool calls inside this turn so
   * the chat UI can correlate iframe refreshes back to the chat pill.
   */
  turnId: string;
  /**
   * Draft code dir for this turn — the session worktree's `apps/<id>/`
   * (issue #144). When set, the dispatcher serves the draft's handlers AND
   * its branched `data.sqlite` (data dir = code dir in draft mode), so the
   * agent authoring a migration can exercise it against prod-seeded draft
   * data without touching live rows. Absent on the data-only chat backend.
   */
  overrideCodeDir?: string;
  /**
   * The vault-assistant register: when set, the adapters expose the vault
   * tools — `vault_sql` (owner-side read-only SQL over the whole vault)
   * and, when `vaultInvoke` is also set, `vault_invoke` (typed commands,
   * parked when high-risk) — instead of the app-scoped `centraid_*` trio.
   * A vault-register turn is not scoped to an app silo, so the trio would
   * only error; the registers swap, never mix.
   */
  vaultSql?: VaultSqlRunner;
  /** The write half of the vault register — only read when `vaultSql` is set. */
  vaultInvoke?: VaultInvokeRunner;
  /** Document-text access (issue #299) — only read when `vaultSql` is set. */
  vaultContent?: VaultContentRunner;
}

/**
 * A file riding the turn's inbound message (issue #190). The bytes already
 * live in the per-app blob CAS; `path` is the absolute on-disk blob path the
 * adapter reads to build an image/document content block.
 */
export interface TurnAttachment {
  path: string;
  mime: string;
  filename?: string;
}

export interface TurnInput {
  /** Working directory the agent operates in (chat: app data dir; builder: app dir). */
  cwd: string;
  message: string;
  /**
   * Files attached to the inbound message. When present, the codex / claude
   * adapters turn the user turn into multimodal content blocks (text + image /
   * document) instead of a bare text prompt (issue #190).
   */
  attachments?: TurnAttachment[];
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
  onEvent: (event: TurnStreamEvent) => void;
}

export interface TurnConfig {
  prefs: RunnerPrefs;
}

export interface TurnResult {
  /** Codex thread id (when `prefs.kind === 'codex'`) or Claude session id. */
  sessionId?: string;
  /** Echoes the runner kind that produced `sessionId`. */
  adapterKind: RunnerPrefs['kind'];
}

/**
 * The thin turn-driver the run engine depends on. agent-runtime's
 * `runTurn` is the production implementation; tests inject a stub.
 * Kept structural (not `typeof runTurn`) so this layer never imports
 * the codex/claude backend.
 */
export type RunTurnFn = (input: TurnInput, config: TurnConfig) => Promise<TurnResult>;
