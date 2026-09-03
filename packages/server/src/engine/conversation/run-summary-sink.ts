import type { RunKind } from "./schema.js";

export interface RunSummary {
  readonly runId: string;
  readonly kind: RunKind;
  readonly automationRef?: string;
  readonly automationName?: string;
  readonly appId?: string;
  readonly trigger: string;
  readonly triggerOrigin?: string;
  readonly ok: boolean;
  readonly pinned?: boolean;
  readonly summary?: string;
  readonly note?: string;
  readonly error?: string;
  readonly retryOf?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly totalInputTokens?: number;
  readonly totalOutputTokens?: number;
  readonly totalCacheReadTokens?: number;
  readonly totalCacheWriteTokens?: number;
  readonly hydrationTokens?: number;
  readonly totalCostUsd?: number;
  readonly stepCount?: number;
  readonly toolCount?: number;
}
