/*
 * Bounded server-sent-event writer (#659).
 *
 * An SSE surface that calls `res.write()` and ignores the result is unbounded.
 * `res.write()` returning `false` means the socket is full and Node is
 * buffering the frame in memory on our behalf — so a client that stops
 * reading (a phone that slept, a tab throttled to a stop, a tunnel that
 * stalled) turns a busy vault's change feed into unbounded RSS growth on the
 * gateway.
 *
 * The policy here is the one SSE was designed for: a stream that cannot keep up
 * is DROPPED, not buffered. `EventSource` reconnects on its own and every
 * consumer of these feeds re-syncs on connect, so a disconnect costs a
 * round-trip while unbounded buffering costs the host. The bound is on Node's
 * own `writableLength` — the bytes it has queued for the socket — because that
 * is the memory actually at risk; keeping a second queue in front of it would
 * only move the growth.
 */

import type { ServerResponse } from "node:http";

/**
 * Roughly a second of a busy change feed. Past this the client is not slow, it
 * is gone: the socket has accepted nothing while we queued a megabyte.
 */
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

interface SseStreamOptions {
  /** Overrides the drop threshold on Node's outbound queue. */
  maxBufferedBytes?: number;
  /** Notified once, when a stream is dropped for backpressure. */
  onOverflow?: (bufferedBytes: number) => void;
}

export class SseStream {
  private readonly res: ServerResponse;
  private readonly maxBufferedBytes: number;
  private readonly onOverflow: ((bufferedBytes: number) => void) | undefined;
  private overflowed = false;

  constructor(res: ServerResponse, options: SseStreamOptions = {}) {
    this.res = res;
    this.maxBufferedBytes =
      options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.onOverflow = options.onOverflow;
  }

  /** True once this stream was dropped for exceeding the buffer bound. */
  get droppedForBackpressure(): boolean {
    return this.overflowed;
  }

  /** Bytes Node currently holds for this socket. */
  get bufferedBytes(): number {
    return this.res.writableLength;
  }

  /** True when the socket is closed, ended, or already dropped. */
  get closed(): boolean {
    return this.overflowed || this.res.writableEnded || this.res.destroyed;
  }

  /**
   * Write one already-framed SSE payload. Returns `false` when the frame was
   * not delivered — either the stream was already closed, or this frame is the
   * one that crossed the bound and dropped it.
   */
  write(frame: string): boolean {
    if (this.closed) return false;
    if (this.res.writableLength > this.maxBufferedBytes) {
      this.dropForBackpressure();
      return false;
    }
    this.res.write(frame);
    return true;
  }

  /** `event:`/`data:` in one frame — the shape every caller here uses. */
  event(type: string, serializedData: string): boolean {
    return this.write(`event: ${type}\ndata: ${serializedData}\n\n`);
  }

  /**
   * A keep-alive comment. Skipped entirely while the socket already needs a
   * drain: a heartbeat exists to prove the connection is alive, and queueing
   * one behind a backlog proves nothing while adding to it.
   */
  comment(text: string): boolean {
    if (this.closed || this.res.writableNeedDrain) return false;
    return this.write(`: ${text}\n\n`);
  }

  /** Graceful end. Idempotent. */
  end(): void {
    if (this.res.writableEnded || this.res.destroyed) return;
    this.res.end();
  }

  private dropForBackpressure(): void {
    if (this.overflowed) return;
    this.overflowed = true;
    const buffered = this.res.writableLength;
    this.onOverflow?.(buffered);
    // destroy(), not end(): end() would flush the very backlog we are dropping.
    this.res.destroy();
  }
}
