/*
 * Host-agnostic chat-runner interface: the route handler implements no model
 * loop, it only translates `TurnStreamEvent`s into SSE frames.
 */

import type { ConversationWorkspaceKind, RunKind } from "./schema.js";
import type {
  HarnessUsageSnapshot,
  HarnessKind,
  TurnAttachment,
} from "./turn.js";
import type * as TypeImport_bjbigq from "./turn.js";

export type HarnessFailureClass =
  | "spawn"
  | "auth"
  | "init"
  | "timeout"
  | "quota"
  | "wedge"
  | "exit"
  | "unknown";

export type TurnStreamEvent =
  | { type: "assistant.start" }
  | { type: "assistant.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  /** `used` may DECREASE after compaction: render the latest, never a max. */
  | { type: "context"; used?: number; size?: number }
  | {
      type: "tool.start";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      sql?: string;
      kind?: string;
      rawJson?: string;
    }
  | {
      type: "tool.result";
      toolCallId: string;
      toolName: string;
      ok: boolean;
      result?: unknown;
      errorText?: string;
      diffs?: Array<{ path?: string; oldText?: string; newText?: string }>;
      locations?: Array<{ path: string; line?: number }>;
      artifacts?: Array<{
        dataBase64: string;
        mime: string;
        filename?: string;
      }>;
      rawJson?: string;
    }
  | {
      type: "phase";
      phase: string;
      detail?: unknown;
      plan?: Array<{ content: string; status?: string; priority?: string }>;
    }
  | {
      type: "final";
      text: string;
      stopReason?: string;
      rawJson?: string;
    }
  | {
      type: "error";
      message: string;
      failureClass?: HarnessFailureClass;
      stopReason?: string;
      rawJson?: string;
    }
  | { type: "aborted" }
  | {
      type: "consent.required";
      consentKind: "provider-egress";
      provider: HarnessKind;
      reason: "direct" | "ladder";
      message: string;
    }
  | { type: "notice"; level: "warn" | "info"; code?: string; message: string }
  /** Surfaced once; `secret` is never persisted (#141). */
  | {
      type: "webhooks";
      minted: Array<{
        automationId: string;
        ownerApp: string;
        webhookId: string;
        url: string;
        secret: string;
      }>;
    }
  | {
      type: "usage";
      model?: string;
      effort?: string;
      harness?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
      costSource?: "harness" | "estimated";
    };

export interface ConversationTurnInput {
  appId: string;
  draftSessionId?: string;
  /** A subprocess harness MUST spawn with this cwd. */
  dataDir: string;
  conversationId: string;
  sessionFile: string;
  message: string;
  register?: "ask" | "build";
  attachments?: TurnAttachment[];
  extraSystemPrompt: string;
  harnessKind?: HarnessKind;
  model?: string;
  configPins?: Readonly<Record<string, string>>;
  providerConsent?: HarnessKind | readonly HarnessKind[];
  additionalDirectories?: string[];
  workspaceDirectory?: string;
  workspaceKind?: ConversationWorkspaceKind;
  thinking?: string;
  /** `deny`: the harness may never widen its grants through a prompt. */
  permissionPolicy?: "auto-allow" | "deny";
  abortSignal: AbortSignal;
  idempotencyKey?: string;
  prevHarnessSessionId?: string;
  prevBindingId?: string;
  activeHarnessKind?: string;
  prevHarnessKind?: string;
  prevHarnessUsageSnapshot?: HarnessUsageSnapshot;
  hydrationContext?: {
    prompt: string;
    includedTurns: number;
    omittedTurns: number;
    estimatedTokens: number;
  };
  hydrationAttachments?: TypeImport_bjbigq.TurnAttachment[];
  recoveryHydrationContext?: {
    prompt: string;
    includedTurns: number;
    omittedTurns: number;
    estimatedTokens: number;
  };
  recoveryHydrationAttachments?: TypeImport_bjbigq.TurnAttachment[];
  /** Every failover rung has its OWN binding and watermark: resolve per rung,
   *  or a fallback starts with neither. */
  resumeForKind?: (kind: HarnessKind) => TurnResumePlan | undefined;
  onEvent: (event: TurnStreamEvent) => void;
}

export interface TurnResumePlan {
  sessionId?: string;
  bindingId?: string;
  usageSnapshot?: HarnessUsageSnapshot;
  hydrationContext?: ConversationTurnInput["hydrationContext"];
  hydrationAttachments?: TypeImport_bjbigq.TurnAttachment[];
  recoveryHydrationContext?: ConversationTurnInput["recoveryHydrationContext"];
  recoveryHydrationAttachments?: TypeImport_bjbigq.TurnAttachment[];
}

export interface ConversationTurnResult {
  harnessSessionId?: string;
  harnessKind?: string;
  harnessUsageSnapshot?: HarnessUsageSnapshot;
  hydrated?: boolean;
  hydrationKind?: "handoff" | "recovery";
  hydrationTokens?: number;
}

export interface ConversationRunner {
  resolveHarnessKind?: () => Promise<HarnessKind | undefined>;
  readonly runKind?: RunKind;
  /** Errors REJECT as well as emitting: the route needs the rejection to
   *  release the per-session lock. */
  run: (input: ConversationTurnInput) => Promise<ConversationTurnResult | void>;
}
