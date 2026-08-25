/* Turn-driver contract, living BELOW every harness implementation. */

import type { Dispatcher } from "../handlers/dispatcher.js";
import type { TurnStreamEvent } from "./runner.js";

/** Add a kind here and its launch spec to agent-runtime's `HarnessSpec`. */
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

export function isHarnessKind(value: unknown): value is HarnessKind {
  return (
    typeof value === "string" &&
    (HARNESS_KINDS as readonly string[]).includes(value)
  );
}

export interface HarnessPrefs {
  kind: HarnessKind;
  binPath?: string;
  extraArgs?: string[];
  configPins?: Readonly<Record<string, string>>;
}

export interface VaultSqlToolResult {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  truncated: boolean;
  durationMs: number;
}

export type VaultSqlRunner = (
  sql: string
) => Promise<VaultSqlToolResult> | VaultSqlToolResult;

export type VaultInvokeRunner = (call: {
  command: string;
  input: Record<string, unknown>;
}) => Promise<unknown> | unknown;

export type VaultContentRunner = (call: {
  contentId: string;
}) => Promise<unknown> | unknown;

export interface ToolContext {
  appId: string;
  dispatcher: Dispatcher;
  turnId: string;
  overrideCodeDir?: string;
  /** Set ⇒ the vault register REPLACES the `centraid_*` trio: never mixed. */
  vaultSql?: VaultSqlRunner;
  vaultInvoke?: VaultInvokeRunner;
  vaultContent?: VaultContentRunner;
}

export interface TurnAttachment {
  path: string;
  mime: string;
  filename?: string;
}

/** ACP reports session TOTALS, not deltas: fed back only on a same-harness
 *  resume, so each turn books exactly once. */
export interface HarnessUsageSnapshot {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cost?: {
    readonly amount: number;
    readonly currency: string;
  };
  readonly contextUsed?: number;
  readonly contextSize?: number;
}

export interface TurnInput {
  conversationId?: string;
  cwd: string;
  message: string;
  attachments?: TurnAttachment[];
  extraSystemPrompt: string;
  model?: string;
  configPins?: Readonly<Record<string, string>>;
  permissionPolicy?: "auto-allow" | "deny";
  prevSessionId?: string;
  prevUsageSnapshot?: HarnessUsageSnapshot;
  hydrationContext?: string;
  hydrationAttachments?: TurnAttachment[];
  recoveryHydrationContext?: string;
  recoveryHydrationAttachments?: TurnAttachment[];
  forceHydration?: boolean;
  additionalDirectories?: string[];
  /** Per-subprocess, never `process.env`: that races concurrent turns. */
  extraPath?: string;
  toolContext?: ToolContext;
  abortSignal: AbortSignal;
  onEvent: (event: TurnStreamEvent) => void;
}

export interface TurnConfig {
  prefs: HarnessPrefs;
}

export interface TurnResult {
  sessionId?: string;
  harnessKind: HarnessPrefs["kind"];
  usageSnapshot?: HarnessUsageSnapshot;
  hydrated?: boolean;
  hydrationKind?: "handoff" | "recovery";
}

export type RunTurnFn = (
  input: TurnInput,
  config: TurnConfig
) => Promise<TurnResult>;
