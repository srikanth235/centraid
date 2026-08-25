/*
 * Conversation ⊃ turn ⊃ item row types (#190); the DDL lives in
 * `RUNTIME_MIGRATIONS`. The CONVERSATION is the spine — `RunKind` lives on it,
 * never re-stamped per turn — and ordinal 0 is the inbound message.
 */

import type { HarnessUsageSnapshot } from "./turn.js";

export type RunKind = "automation" | "chat" | "build";

export type AutomationTriggerKind =
  | "scheduled"
  | "manual"
  | "replay"
  | "on_failure"
  | "compile"
  | "interactive";

export type AutomationTriggerOrigin =
  | "cron"
  | "webhook"
  | "manual"
  | "condition"
  | "data"
  | "event";

export type ItemKind = "message_in" | "step" | "tool" | "delegate";

export interface Conversation {
  readonly id: string;
  readonly kind: RunKind;
  readonly userId: string;
  readonly appId?: string;
  readonly automationId?: string;
  readonly title: string;
  readonly harnessKind?: string;
  readonly harnessSessionId?: string;
  readonly harnessUsageSnapshot?: HarnessUsageSnapshot;
  readonly hydrationCount: number;
  readonly lastHydratedAt?: number;
  readonly turnCount: number;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One per harness the conversation has used; `stale` means unusable.
 *  `hydratedThroughSeq` is the last turn that session observed, so A → B → A
 *  resumes A and hydrates only B's delta. */
export interface ConversationHarnessSession {
  readonly id: string;
  readonly conversationId: string;
  readonly kind: string;
  readonly acpSessionId: string;
  readonly usageSnapshot?: HarnessUsageSnapshot;
  readonly hydratedThroughSeq: number;
  readonly status: "active" | "warm" | "cold" | "stale";
  readonly lastUsedAt: number;
  readonly createdAt: number;
}

export type ConversationWorkspaceKind = "vault-data" | "app" | "draft";

export interface ConversationWorkspaceSelection {
  readonly conversationId: string;
  readonly primaryKind: ConversationWorkspaceKind;
  readonly additionalDirectories: string[];
  readonly updatedAt: number;
}

export interface Turn {
  readonly turnId: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly parentTurnId?: string;
  readonly triggerKind: AutomationTriggerKind;
  readonly triggerOrigin?: AutomationTriggerOrigin;
  readonly note?: string;
  readonly retryOf?: string;
  readonly idempotencyKey?: string;
  readonly hydrationTokens?: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly feedback?: "up" | "down";
  readonly summary?: string;
  readonly outputJson?: string;
  readonly pinned: boolean;
  readonly totalInputTokens?: number;
  readonly totalOutputTokens?: number;
  readonly totalCacheReadTokens?: number;
  readonly totalCacheWriteTokens?: number;
  readonly totalCostUsd?: number;
  readonly stepCount?: number;
  readonly toolCount?: number;
}

export interface Item {
  readonly itemId: string;
  readonly turnId: string;
  readonly ordinal: number;
  /** ACP tool calls OVERLAP: correlate on this, never name or ordinal. */
  readonly callId?: string;
  readonly batchId?: number;
  readonly kind: ItemKind;
  readonly role?: "user" | "assistant";
  readonly text?: string;
  readonly name?: string;
  readonly argsJson?: string;
  readonly outputJson?: string;
  readonly rawJson?: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly model?: string;
  readonly harness?: string;
  readonly effort?: string;
  readonly costUsd?: number;
  readonly costSource?: "harness" | "estimated";
  readonly appId?: string;
  readonly childTurnId?: string;
}

export interface Attachment {
  readonly id: string;
  readonly itemId: string;
  readonly hash: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly source?: string;
  readonly filename?: string;
  /** Present ⇒ the bytes are NOT in CAS. */
  readonly workspacePath?: string;
  readonly createdAt: number;
}

export interface AutomationStateEntry {
  readonly automationId: string;
  readonly key: string;
  readonly valueJson: string;
  readonly updatedAt: number;
}
