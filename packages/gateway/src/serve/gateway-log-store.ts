/*
 * Gateway log store — the capture point behind the realtime Logs surface.
 *
 * Every gateway log line today goes straight to `console.*` via the
 * `RuntimeLogger` threaded through `buildGateway` and dies there: when
 * something goes wrong on a user's machine there is nothing the UI can
 * show. This store fixes that with the same shape as `RunEventBus`
 * (subscribe/fan-out, ephemeral) plus a bounded ring buffer so a client
 * that opens the Logs screen AFTER the interesting lines fired still
 * sees them.
 *
 * `wrap(inner)` returns a `RuntimeLogger` that tees each line into the
 * buffer + subscribers and then forwards to `inner` (the console logger
 * or a host-injected one) — console output is unchanged. Entries carry a
 * monotonic `seq` so clients resume (`?after=`) and dedupe across
 * reconnects.
 */

import type { RuntimeLogger } from '@centraid/app-engine';

export type GatewayLogLevel = 'info' | 'warn' | 'error';

export interface GatewayLogEntry {
  /** Monotonic per-process sequence — resume/dedupe cursor. */
  seq: number;
  /** Epoch ms the line was emitted. */
  ts: number;
  level: GatewayLogLevel;
  message: string;
}

export type GatewayLogListener = (entry: GatewayLogEntry) => void;

/** Ring capacity: enough to hold a session's worth of gateway chatter
 *  (boot mounts + scheduler + outbox) without unbounded growth. */
const DEFAULT_CAPACITY = 2000;

export class GatewayLogStore {
  private readonly capacity: number;
  private readonly entries: GatewayLogEntry[] = [];
  private readonly listeners = new Set<GatewayLogListener>();
  private nextSeq = 1;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  /** Record one line: buffer it (evicting the oldest past capacity) and
   *  fan it out to every live subscriber. */
  append(level: GatewayLogLevel, message: string): GatewayLogEntry {
    const entry: GatewayLogEntry = { seq: this.nextSeq++, ts: Date.now(), level, message };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    // Snapshot: a listener may unsubscribe itself mid-fanout.
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(entry);
      } catch {
        /* one wedged subscriber must not break the fanout */
      }
    }
    return entry;
  }

  /** Buffered entries with `seq > afterSeq`, oldest first. */
  snapshot(afterSeq = 0): GatewayLogEntry[] {
    if (afterSeq <= 0) return [...this.entries];
    return this.entries.filter((e) => e.seq > afterSeq);
  }

  /** Subscribe to live entries. Returns an idempotent unsubscribe. */
  subscribe(fn: GatewayLogListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Live subscriber count — used by tests. */
  subscriberCount(): number {
    return this.listeners.size;
  }

  /** Tee a `RuntimeLogger`: capture into this store, then forward to
   *  `inner` so console/host output is unchanged. */
  wrap(inner: RuntimeLogger): RuntimeLogger {
    return {
      info: (m) => {
        this.append('info', m);
        inner.info(m);
      },
      warn: (m) => {
        this.append('warn', m);
        inner.warn(m);
      },
      error: (m) => {
        this.append('error', m);
        inner.error(m);
      },
    };
  }
}
