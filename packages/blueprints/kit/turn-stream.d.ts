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
  | { type: 'assistant.start' }
  | { type: 'assistant.delta'; delta: string }
  | { type: 'reasoning.delta'; delta: string }
  | { type: 'tool.start'; toolCallId: string; toolName: string; args?: unknown; sql?: string }
  | {
      type: 'tool.result';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      result?: unknown;
      errorText?: string;
    }
  | { type: 'phase'; phase: string; detail?: unknown }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }
  | { type: 'aborted' }
  /** Non-fatal, human-readable notice (issue #420) — e.g. a runner that can't
   *  read PDF attachments. Rendered in the transcript, never persisted. */
  | { type: 'notice'; level: 'warn' | 'info'; code?: string; message: string }
  | {
      type: 'usage';
      model?: string;
      provider?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      /** USD estimate, priced server-side (model-pricing.ts) at the SSE seam. */
      costUsd?: number;
    }
  | {
      type: 'webhooks';
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
 * Read a `_turn` SSE body to completion, dispatching each parsed event.
 * Resolves `{ ended: true }` when the terminal `event: end` frame was seen,
 * `{ ended: false }` when the body closed mid-turn (the catch-up signal).
 */
export function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: TurnStreamEvent) => void,
  opts?: { signal?: AbortSignal },
): Promise<{ ended: boolean }>;
