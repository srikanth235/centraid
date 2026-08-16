// The turn-stream core — the ONE SSE frame parser every conversation surface
// drives its `_turn` streams through, and the ONE documented wire union those
// surfaces speak, so a wire-protocol change lands once.
//
// The gateway emits each event as an SSE frame:
//     event: <type>\n
//     data: <json>\n\n      (the JSON also carries `type`)
// plus `: <comment>\n\n` banner/heartbeat frames and a closing
// `event: end\ndata: {}\n\n`. We read the type off the parsed JSON (robust to
// the `end` frame, whose `{}` has no `type`), matching driveTurnOverSse's
// serialization in packages/app-engine/src/http/turn-sse.ts.
//
// `TurnStreamEvent` mirrors `@centraid/app-engine`'s union (packages/app-engine/
// src/conversation/runner.ts); it is declared here rather than imported so the
// browser client carries no Node package dependency.

/** The gateway's native conversation-stream event. */
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

/**
 * Split a raw SSE frame (already delimited on the blank line) into its
 * concatenated `data:` payload. Comment frames (`:` heartbeats/banners) and
 * `event:` lines are ignored — the type lives inside the JSON. Returns '' when
 * the frame carries no data lines.
 */
export function frameData(rawFrame: string): string {
  let data = "";
  for (const line of rawFrame.split("\n")) {
    // `data:foo` and `data: foo` are both valid — trim one leading space.
    if (line.slice(0, 5) === "data:") data += line.slice(5).replace(/^ /u, "");
  }
  return data;
}

/**
 * Parse one raw frame into a `TurnStreamEvent`, or null when it carries no
 * event (a heartbeat, banner, the terminal `end` frame, or malformed JSON —
 * a bad frame is skipped, never fatal to the stream).
 */
export function parseFrame(rawFrame: string): TurnStreamEvent | null {
  const data = frameData(rawFrame);
  if (!data) return null;
  try {
    const evt: unknown = JSON.parse(data);
    if (evt && typeof (evt as { type?: unknown }).type === "string")
      return evt as TurnStreamEvent;
  } catch {
    /* skip a malformed frame rather than abort the stream */
  }
  return null;
}

/**
 * True when a raw frame is the gateway's terminal `event: end` frame — the
 * clean "the server finished this turn" marker (issue #420). Its `data: {}`
 * carries no `type`, so `parseFrame` returns null for it; catch-up-on-reconnect
 * needs to tell "stream closed AFTER the server finished" (end seen) from
 * "connection dropped mid-turn" (end never seen).
 */
export function isEndFrame(rawFrame: string): boolean {
  for (const line of rawFrame.split("\n")) {
    // `event:end` and `event: end` are both valid — trim one leading space.
    if (
      line.slice(0, 6) === "event:" &&
      line.slice(6).replace(/^ /u, "") === "end"
    )
      return true;
  }
  return false;
}

/**
 * Parse a whole SSE text blob into events — the pure, stream-free core used by
 * both `consumeSse` and unit tests. Frames are separated by a blank line.
 */
export function parseSseText(text: string): TurnStreamEvent[] {
  const out: TurnStreamEvent[] = [];
  for (const frame of text.split("\n\n")) {
    const evt = parseFrame(frame);
    if (evt) out.push(evt);
  }
  return out;
}

/**
 * Consume complete SSE frames in wire order. This is the ordered boundary for
 * every fetch-based SSE client: chunks must be read one at a time so partial
 * frames can be reassembled, while callers keep their frame handling pure and
 * synchronous. Keeping that contract here prevents each transport surface from
 * inventing its own raw await-in-a-loop reader.
 */
export async function consumeSseFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (rawFrame: string) => void,
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  const { signal } = opts;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  async function consumeNext(): Promise<void> {
    if (signal?.aborted) return;
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf("\n\n");
    while (sep >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      onFrame(frame);
      sep = buf.indexOf("\n\n");
    }
    return consumeNext();
  }
  try {
    await consumeNext();
  } finally {
    void reader.cancel().catch(() => {
      /* reader already released */
    });
  }
}

/**
 * Read a `_turn` SSE response body to completion, dispatching each parsed
 * `TurnStreamEvent` to `onEvent`. Resolves when the stream ends (the gateway's
 * `event: end` frame / connection close). Pass `signal` to bail the read loop
 * when the caller aborts the fetch (Stop button / panel teardown) — the
 * in-flight `reader.read()` rejects on abort, which we swallow so cancel is
 * clean rather than a thrown error.
 *
 * Returns `{ ended }`: `true` when the terminal `event: end` frame was seen
 * (the server finished the turn), `false` when the body closed WITHOUT it — the
 * mid-turn-drop signal the shell uses to trigger catch-up-from-ledger. A thrown
 * network error (connection reset) also means `ended` never became true, so the
 * caller's catch block treats a throw the same as a `false` return.
 */
export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: TurnStreamEvent) => void,
  opts: { signal?: AbortSignal } = {}
): Promise<{ ended: boolean }> {
  const { signal } = opts;
  let ended = false;
  try {
    await consumeSseFrames(
      body,
      (frame) => {
        if (isEndFrame(frame)) ended = true;
        const evt = parseFrame(frame);
        if (evt) onEvent(evt);
      },
      opts
    );
  } catch (error) {
    // An abort surfaces as an AbortError on the pending read — that's the Stop
    // button doing its job, not a stream failure. Re-throw anything else.
    if (!signal?.aborted && (error as Error | null)?.name !== "AbortError")
      throw error;
  }
  return { ended };
}
