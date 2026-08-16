/*
 * Turn-driver contract — the host-agnostic interface between a run spine and
 * the harness that actually drives one model turn.
 *
 * These types used to live in `@centraid/server/acp` (the local
 * codex/claude harness). They moved down here so the harness-agnostic run
 * engine (`makeConversationRunnerCore`, the automation fire spine) can speak the
 * turn contract without depending on any harness implementation — agent-runtime and
 * the gateway both inject a concrete `RunTurnFn` that satisfies it. The
 * interface lives here next to `ConversationRunner`; the codex/claude
 * implementation (`runTurn`) stays in agent-runtime.
 */

import type { Dispatcher } from "../handlers/dispatcher.js";
import type { TurnStreamEvent } from "./runner.js";

/**
 * Every harness kind the runtime knows how to drive — the single
 * source of truth. Since issue #479 they all share one transport, the
 * generic ACP (Agent Client Protocol) harness: `gemini`, `qwen`,
 * `opencode`, `grok` and `kimi` speak ACP natively, while `codex` and
 * `claude-code` reach it through their first-party adapters. `acp` is
 * the escape hatch for any other ACP-speaking CLI, configured entirely
 * through `HarnessPrefs` (`binPath` + `extraArgs` supply the binary and
 * its ACP flag).
 *
 * agent-runtime owns a `HarnessSpec` registry keyed on these values;
 * add a kind here and register its launch spec there — nothing switches on
 * a hardcoded per-kind literal anymore.
 */
export const HARNESS_KINDS = [
  "codex",
  "claude-code",
  "gemini",
  "qwen",
  "opencode",
  "grok",
  "kimi",
  "copilot",
  "cursor",
  "kilo",
  "cline",
  "goose",
  "auggie",
  "vibe",
  "droid",
  "pi",
  "acp",
] as const;

export type HarnessKind = (typeof HARNESS_KINDS)[number];

/** Validation guard for persisted/wire strings that claim to be a harness kind. */
export function isHarnessKind(value: unknown): value is HarnessKind {
  return (
    typeof value === "string" &&
    (HARNESS_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Per-user settings for the harness. Persisted by the desktop's
 * UserStore (gateway DB, `user_prefs`) under the `harness.*` keys.
 * The host loads + passes these into `makeConversationRunner` (for chat) or
 * directly into `runTurn` (for builder).
 */
export interface HarnessPrefs {
  /** Which CLI/SDK to invoke. Required when the desktop is in local-runtime mode. */
  kind: HarnessKind;
  /** Override the binary location; defaults to PATH lookup. */
  binPath?: string;
  /** Extra args passed verbatim to the CLI invocation. */
  extraArgs?: string[];
  /**
   * Category-keyed ACP configuration defaults. Well-known categories are
   * `model` and `thought_level`; unknown future categories remain open strings.
   */
  configPins?: Readonly<Record<string, string>>;
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
 * callback in here; a refused/broken statement throws with the message the
 * model needs to self-correct.
 */
export type VaultSqlRunner = (
  sql: string
) => Promise<VaultSqlToolResult> | VaultSqlToolResult;

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
export type VaultContentRunner = (call: {
  contentId: string;
}) => Promise<unknown> | unknown;

/**
 * Per-turn binding that lets harnesses register the vault-register tools
 * (`vault_sql` / `vault_invoke`, when the handlers below are threaded in)
 * and emit provenanced change-bus events. Optional — when absent (tests),
 * harnesses register no data tools.
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
   * harness authoring a migration can exercise it against prod-seeded draft
   * data without touching live rows. Absent on the data-only conversation driver.
   */
  overrideCodeDir?: string;
  /**
   * The vault-assistant register: when set, the harnesses expose the vault
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
 * harness reads to build an image/document content block.
 */
export interface TurnAttachment {
  path: string;
  mime: string;
  filename?: string;
}

/**
 * Last cumulative counters reported by one resumable ACP session.
 *
 * ACP reports session totals, not per-prompt deltas. Hosts persist this
 * snapshot beside the opaque session id and feed it back only when the same
 * harness resumes that session, so the ACP client can book each turn exactly
 * once even after a process restart.
 */
export interface HarnessUsageSnapshot {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cost?: {
    readonly amount: number;
    readonly currency: string;
  };
  /** Last observed ACP context-window snapshot (not a monotonic counter). */
  readonly contextUsed?: number;
  readonly contextSize?: number;
}

export interface TurnInput {
  /** Stable ledger identity; scopes the optional warm-process cache. */
  conversationId?: string;
  /** Working directory the harness operates in (conversation: app data dir; builder: app dir). */
  cwd: string;
  message: string;
  /**
   * Files attached to the inbound message. When present, the codex / claude
   * adapters turn the user turn into multimodal content blocks (text + image /
   * document) instead of a bare text prompt (issue #190).
   */
  attachments?: TurnAttachment[];
  /** Harness-specific append point: codex `developerInstructions` / claude `systemPrompt.append`. */
  extraSystemPrompt: string;
  model?: string;
  /** Per-turn category-keyed pins; higher precedence than HarnessPrefs defaults. */
  configPins?: Readonly<Record<string, string>>;
  /**
   * How ACP `session/request_permission` calls are answered. `deny` is a
   * structural boundary used by automation conversations: the harness keeps
   * its pre-granted surface and every request to expand it is cancelled.
   */
  permissionPolicy?: "auto-allow" | "deny";
  /** Resume id from a prior turn (codex thread id / claude session id). */
  prevSessionId?: string;
  /** Cumulative usage stored with `prevSessionId`; ignored for a fresh session. */
  prevUsageSnapshot?: HarnessUsageSnapshot;
  /** Canonical ledger handoff, consumed only if a fresh session is required. */
  hydrationContext?: string;
  /** Historical files from the retained hydration turns. */
  hydrationAttachments?: TurnAttachment[];
  /** Full-ledger handoff reserved for an expired same-harness resume handle. */
  recoveryHydrationContext?: string;
  /** Full-ledger historical files for expired-session recovery. */
  recoveryHydrationAttachments?: TurnAttachment[];
  /** A harness change has already established that hydration is required. */
  forceHydration?: boolean;
  /**
   * Extra absolute workspace roots for ACP harnesses that advertise
   * `sessionCapabilities.additionalDirectories` (monorepo / skills dirs).
   */
  additionalDirectories?: string[];
  /**
   * Directories to prepend to PATH for any subprocess the harness spawns
   * (codex's shell tool, claude's Bash tool). Path-delimited string —
   * `path.delimiter` between entries. Used to expose the `centraid` CLI
   * without mutating the host's `process.env` (which would race between
   * concurrent turns). Empty / undefined = no PATH override.
   */
  extraPath?: string;
  /**
   * Inline-tool wiring. When present, the harnesses declare the vault tools
   * (`vault_sql` / `vault_invoke`) and dispatch them in-process; without
   * it, the harness falls back to its generic shell tool. Conversation callers always
   * supply one; builder callers (no per-app data file) omit it.
   */
  toolContext?: ToolContext;
  abortSignal: AbortSignal;
  onEvent: (event: TurnStreamEvent) => void;
}

export interface TurnConfig {
  prefs: HarnessPrefs;
}

export interface TurnResult {
  /** Codex thread id (when `prefs.kind === 'codex'`) or Claude session id. */
  sessionId?: string;
  /** Echoes the harness kind that produced `sessionId`. */
  harnessKind: HarnessPrefs["kind"];
  /** Cumulative usage to persist beside `sessionId` for the next delta. */
  usageSnapshot?: HarnessUsageSnapshot;
  /** True when this fresh session consumed the canonical ledger handoff. */
  hydrated?: boolean;
  /** Which bounded plan was actually consumed, for honest D4 accounting. */
  hydrationKind?: "handoff" | "recovery";
}

/**
 * The thin turn-driver the run engine depends on. agent-runtime's
 * `runTurn` is the production implementation; tests inject a stub.
 * Kept structural (not `typeof runTurn`) so this layer never imports
 * a concrete Codex/Claude harness runtime.
 */
export type RunTurnFn = (
  input: TurnInput,
  config: TurnConfig
) => Promise<TurnResult>;
