// Type contract for the shared turn-stream core (issue #420). This is the ONE
// documented wire union both chat surfaces speak. `packages/client`'s
// gateway-client-conversation.ts re-exports `TurnStreamEvent` from here so the
// renderer/protocol contract has a single source of truth.
//
// Mirrors `@centraid/app-engine`'s `TurnStreamEvent` (packages/app-engine/src/
// conversation/runner.ts) — kept as a hand-authored declaration so the vanilla
// kit module carries no Node package dependency.

/** The gateway's native chat-stream event. */
export type TurnStreamEvent =
  | { type: "assistant.start" }
  | { type: "assistant.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
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
      /** `hash` is the CAS sha256 when the runner reported one — the chip shows
       *  it, matching the reloaded transcript's artifact chips (#567). */
      artifacts?: Array<{
        dataBase64: string;
        mime: string;
        filename?: string;
        hash?: string;
      }>;
      rawJson?: string;
    }
  | {
      type: "phase";
      phase: string;
      detail?: unknown;
      plan?: Array<{ content: string; status?: string; priority?: string }>;
    }
  | { type: "final"; text: string; stopReason?: string; rawJson?: string }
  | {
      type: "error";
      message: string;
      failureClass?:
        | "spawn"
        | "auth"
        | "init"
        | "timeout"
        | "quota"
        | "wedge"
        | "exit"
        | "unknown";
      stopReason?: string;
      rawJson?: string;
    }
  | { type: "aborted" }
  | {
      type: "consent.required";
      consentKind: "provider-egress";
      provider: string;
      reason: "direct" | "ladder";
      message: string;
    }
  /** Non-fatal, human-readable notice (issue #420) — e.g. a runner that can't
   *  read PDF attachments. Rendered in the transcript live AND persisted with
   *  the turn, so a reload replays it (#567). */
  | { type: "notice"; level: "warn" | "info"; code?: string; message: string }
  | {
      type: "usage";
      model?: string;
      provider?: string;
      /** ACP-confirmed semantic thought_level; absent when unsupported/unconfirmed. */
      effort?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      /** Harness-reported or catalog-estimated USD (see costSource). */
      costUsd?: number;
      costSource?: "harness" | "estimated";
    }
  /** COMPAT additive (#567): live context-window usage may move non-monotonically. */
  | { type: "context"; used?: number; size?: number }
  | {
      type: "webhooks";
      minted: Array<{
        automationId: string;
        ownerApp: string;
        webhookId: string;
        url: string;
        secret: string;
      }>;
    };

/** Extract the concatenated `data:` payload from one raw SSE frame. */
export function frameData(rawFrame: string): string;

/** Parse one raw SSE frame into an event, or null (heartbeat/end/malformed). */
export function parseFrame(rawFrame: string): TurnStreamEvent | null;

/** True when a raw frame is the terminal `event: end` frame (server finished). */
export function isEndFrame(rawFrame: string): boolean;

/** Parse a whole SSE text blob into events (pure; used by tests). */
export function parseSseText(text: string): TurnStreamEvent[];

/**
 * Read an SSE body in transport order and dispatch each complete raw frame.
 * Frame callbacks are synchronous; use this as the single fetch-SSE boundary.
 */
export function consumeSseFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (rawFrame: string) => void,
  opts?: { signal?: AbortSignal }
): Promise<void>;

/**
 * Read a `_turn` SSE body to completion, dispatching each parsed event.
 * Resolves `{ ended: true }` when the terminal `event: end` frame was seen,
 * `{ ended: false }` when the body closed mid-turn (the catch-up signal).
 */
export function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: TurnStreamEvent) => void,
  opts?: { signal?: AbortSignal }
): Promise<{ ended: boolean }>;
