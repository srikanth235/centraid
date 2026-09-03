/*
 * The bounded in-memory buffer every seat's spans land in (#927 OQ1).
 *
 * Its own module because it is the one piece of the seat tracer that is
 * platform-free and separately testable, and because a phone's ring is the
 * whole storage story between two background passes.
 */

import type { TraceRecord } from "@centraid/core/protocol";

/** Enough to hold a journey's worth of taps; older records fall off the back. */
export const DEFAULT_TRACE_RING_CAPACITY = 64;

/** A bounded, allocation-stable ring of finished records. */
export class ClientTraceRing {
  readonly #records: TraceRecord[] = [];

  constructor(readonly capacity = DEFAULT_TRACE_RING_CAPACITY) {}

  push(record: TraceRecord): void {
    this.#records.push(record);
    while (this.#records.length > this.capacity) this.#records.shift();
  }

  /** Oldest first. Non-destructive — `drain()` is the one that empties. */
  snapshot(): readonly TraceRecord[] {
    return [...this.#records];
  }

  /** Take everything and empty the ring; what a flush calls. */
  drain(): TraceRecord[] {
    return this.#records.splice(0);
  }

  get size(): number {
    return this.#records.length;
  }
}
