// Shared turn-stream core (issue #420) — the ONE SSE frame parser for every
// chat surface. Canonical copy: packages/blueprints/kit/turn-stream.js. Both
// the kit's Ask panel (served verbatim as a native ESM sibling of kit.js) and
// the React shell (packages/client, which re-exports this) drive their `_turn`
// streams through `consumeSse` here, so a wire-protocol change lands once.
//
// The gateway emits each event as an SSE frame:
//     event: <type>\n
//     data: <json>\n\n      (the JSON also carries `type`)
// plus `: <comment>\n\n` banner/heartbeat frames and a closing
// `event: end\ndata: {}\n\n`. We read the type off the parsed JSON (robust to
// the `end` frame, whose `{}` has no `type`), matching driveTurnOverSse's
// serialization in packages/app-engine/src/http/turn-sse.ts.
//
// The event union (`TurnStreamEvent`) is documented in turn-stream.d.ts — the
// single wire contract the TS client re-exports.

/**
 * Split a raw SSE frame (already delimited on the blank line) into its
 * concatenated `data:` payload. Comment frames (`:` heartbeats/banners) and
 * `event:` lines are ignored — the type lives inside the JSON. Returns '' when
 * the frame carries no data lines.
 * @param {string} rawFrame
 * @returns {string}
 */
export function frameData(rawFrame) {
  let data = '';
  for (const line of rawFrame.split('\n')) {
    // `data:foo` and `data: foo` are both valid — trim one leading space.
    if (line.slice(0, 5) === 'data:') data += line.slice(5).replace(/^ /, '');
  }
  return data;
}

/**
 * Parse one raw frame into a `TurnStreamEvent`, or null when it carries no
 * event (a heartbeat, banner, the terminal `end` frame, or malformed JSON —
 * a bad frame is skipped, never fatal to the stream).
 * @param {string} rawFrame
 * @returns {import('./turn-stream.js').TurnStreamEvent | null}
 */
export function parseFrame(rawFrame) {
  const data = frameData(rawFrame);
  if (!data) return null;
  try {
    const evt = JSON.parse(data);
    if (evt && typeof evt.type === 'string') return evt;
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
 * @param {string} rawFrame
 * @returns {boolean}
 */
export function isEndFrame(rawFrame) {
  for (const line of rawFrame.split('\n')) {
    // `event:end` and `event: end` are both valid — trim one leading space.
    if (line.slice(0, 6) === 'event:' && line.slice(6).replace(/^ /, '') === 'end') return true;
  }
  return false;
}

/**
 * Parse a whole SSE text blob into events — the pure, stream-free core used by
 * both `consumeSse` and unit tests. Frames are separated by a blank line.
 * @param {string} text
 * @returns {import('./turn-stream.js').TurnStreamEvent[]}
 */
export function parseSseText(text) {
  const out = [];
  for (const frame of text.split('\n\n')) {
    const evt = parseFrame(frame);
    if (evt) out.push(evt);
  }
  return out;
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
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {(event: import('./turn-stream.js').TurnStreamEvent) => void} onEvent
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ended: boolean }>}
 */
export async function consumeSse(body, onEvent, opts = {}) {
  const { signal } = opts;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ended = false;
  try {
    for (;;) {
      if (signal && signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (isEndFrame(frame)) ended = true;
        const evt = parseFrame(frame);
        if (evt) onEvent(evt);
      }
    }
  } catch (err) {
    // An abort surfaces as an AbortError on the pending read — that's the Stop
    // button doing its job, not a stream failure. Re-throw anything else.
    if (!(signal && signal.aborted) && !(err && err.name === 'AbortError')) throw err;
  } finally {
    try {
      reader.cancel();
    } catch {
      /* reader already released */
    }
  }
  return { ended };
}
