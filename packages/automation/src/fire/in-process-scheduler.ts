/**
 * In-process cron scheduler (issue #149) — n8n semantics.
 *
 * The always-on server (the local gateway) owns cron triggers in-process:
 * a single minute-boundary timer over an in-memory registry of enabled
 * cron automations. There is no OS-level scheduler.
 *
 * Consequences, accepted deliberately (this reverses #69's "fire even when
 * the desktop is closed"):
 *   - Automations fire **only while the scheduler is running**.
 *   - Minutes missed during downtime are **silently skipped — no backfill**.
 *     The `lastFiredMinute` guard means each wall-clock minute is processed at
 *     most once; the timer never replays minutes it slept through.
 *
 * Pure-ish by construction: the clock (`now`) and the effect (`fire`) are
 * injected, so the firing logic is unit-testable by calling `tick()` with a
 * mocked clock. The fire effect is a `(ref) => …` callback — the host wires
 * it to its execution surface (the gateway points it at
 * `runAutomation`).
 *
 * Implements `Host`, keyed by each automation's globally-unique
 * `<ownerApp>/<id>` ref. Only the gateway's `reconcile(rows)` path is
 * exercised in practice; `register`/`unregister`/`list` round it out.
 */

import type { Host, ReconcileResult } from './host.js';
import type { Row } from '../scaffold/app.js';
import { cronTriggersOf, watchTriggersOf } from '../manifest/manifest.js';
import { cronMatches } from './cron-match.js';

export interface InProcessSchedulerOptions {
  /**
   * Fire one automation by its globally-unique `<ownerApp>/<id>` ref. The
   * scheduler does not await it — a slow fire must never stall the timer —
   * but a returned rejection is routed to `onError`.
   */
  fire: (ref: string) => void | Promise<void>;
  /**
   * Evaluate one condition/data trigger (identified by its index in
   * `manifest.triggers`) when its `every` gate matches the minute. The host
   * runs the consented read and decides whether to fire — the scheduler only
   * keeps the clock. Optional: a host without a vault plane registers no
   * evaluator and condition triggers simply never gate open.
   */
  evaluate?: (ref: string, triggerIndex: number) => void | Promise<void>;
  /** Clock seam for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Sink for fire rejections and diagnostics. */
  onError?: (err: unknown, ref: string) => void;
  /**
   * Fired once per processed minute, BEFORE any fire (issue #351): the host's
   * hook for per-tick bookkeeping that has nothing to do with any one
   * automation — the missed-run ledger (`scheduler-ledger.ts`) and liveness
   * probing both hang off this rather than widening `Host`/`LocalScheduler`,
   * so an injected test double (`stubScheduler` et al.) never needs it.
   */
  onTick?: (at: Date) => void;
}

interface SchedulerEntry {
  readonly ref: string;
  readonly crons: readonly string[];
  /** Condition-trigger gates: the `every` cron + the trigger's index. */
  readonly watches: readonly { readonly expr: string; readonly index: number }[];
}

/** `Host` + the lifecycle the owning server drives. */
export interface LocalScheduler extends Host {
  /** Start the minute-boundary timer. Idempotent. */
  start(): void;
  /** Stop the timer. Idempotent. */
  stop(): Promise<void>;
}

export class InProcessScheduler implements LocalScheduler {
  private readonly entries = new Map<string, SchedulerEntry>();
  private readonly fire: (ref: string) => void | Promise<void>;
  private readonly evaluate?: (ref: string, triggerIndex: number) => void | Promise<void>;
  private readonly now: () => Date;
  private readonly onError?: (err: unknown, ref: string) => void;
  private readonly onTick?: (at: Date) => void;
  private boundary?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private lastFiredMinute?: string;

  constructor(opts: InProcessSchedulerOptions) {
    this.fire = opts.fire;
    this.evaluate = opts.evaluate;
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError;
    this.onTick = opts.onTick;
  }

  async register(row: Row): Promise<void> {
    const entry = entryOf(row);
    // The host's toggle path: a disabled or trigger-less automation is
    // simply not scheduled.
    if (!row.enabled || (entry.crons.length === 0 && entry.watches.length === 0)) {
      this.entries.delete(row.ref);
      return;
    }
    this.entries.set(row.ref, entry);
  }

  async unregister(ref: string): Promise<void> {
    this.entries.delete(ref);
  }

  async list(): Promise<readonly string[]> {
    return [...this.entries.keys()].sort();
  }

  async reconcile(desired: ReadonlyArray<Row>): Promise<ReconcileResult> {
    const next = new Map<string, SchedulerEntry>();
    for (const row of desired) {
      if (!row.enabled) continue;
      const entry = entryOf(row);
      if (entry.crons.length > 0 || entry.watches.length > 0) next.set(row.ref, entry);
    }

    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    for (const [ref, entry] of next) {
      const prev = this.entries.get(ref);
      if (!prev) added.push(ref);
      else if (!sameCrons(prev.crons, entry.crons) || !sameWatches(prev.watches, entry.watches))
        updated.push(ref);
    }
    for (const ref of this.entries.keys()) {
      if (!next.has(ref)) removed.push(ref);
    }

    this.entries.clear();
    for (const [ref, entry] of next) this.entries.set(ref, entry);
    return { added: added.sort(), updated: updated.sort(), removed: removed.sort() };
  }

  /**
   * Process the current wall-clock minute: fire every registered automation
   * with a cron trigger matching `now()`. At most once per minute (no
   * backfill of minutes the timer slept through). Public so tests can drive
   * it with a mocked clock.
   */
  tick(): void {
    const at = this.now();
    const minute = minuteKey(at);
    if (minute === this.lastFiredMinute) return;
    this.lastFiredMinute = minute;
    try {
      this.onTick?.(at);
    } catch (err) {
      this.onError?.(err, '<scheduler-tick>');
    }
    for (const entry of this.entries.values()) {
      if (entry.crons.some((expr) => cronMatches(expr, at))) {
        this.fireSafely(entry.ref);
      }
      if (this.evaluate) {
        for (const watch of entry.watches) {
          if (cronMatches(watch.expr, at)) this.evaluateSafely(entry.ref, watch.index);
        }
      }
    }
  }

  start(): void {
    if (this.boundary || this.interval) return;
    // Align the first tick to the top of the next minute, then tick every
    // minute. `unref` so a running scheduler never keeps the process alive.
    this.boundary = setTimeout(() => {
      this.boundary = undefined;
      this.tick();
      this.interval = setInterval(() => this.tick(), 60_000);
      this.interval.unref?.();
    }, msToNextMinute(this.now()));
    this.boundary.unref?.();
  }

  async stop(): Promise<void> {
    if (this.boundary) {
      clearTimeout(this.boundary);
      this.boundary = undefined;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private fireSafely(ref: string): void {
    try {
      const r = this.fire(ref);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err) => this.onError?.(err, ref));
      }
    } catch (err) {
      this.onError?.(err, ref);
    }
  }

  private evaluateSafely(ref: string, triggerIndex: number): void {
    try {
      const r = this.evaluate?.(ref, triggerIndex);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err) => this.onError?.(err, ref));
      }
    } catch (err) {
      this.onError?.(err, ref);
    }
  }
}

function entryOf(row: Row): SchedulerEntry {
  return {
    ref: row.ref,
    crons: cronTriggersOf(row.triggers).map((t) => t.expr),
    watches: watchTriggersOf(row.triggers).map(({ expr, index }) => ({ expr, index })),
  };
}

function sameCrons(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((expr, i) => expr === b[i]);
}

function sameWatches(
  a: readonly { expr: string; index: number }[],
  b: readonly { expr: string; index: number }[],
): boolean {
  return (
    a.length === b.length && a.every((w, i) => w.expr === b[i]!.expr && w.index === b[i]!.index)
  );
}

/** `YYYY-MM-DDTHH:mm` in local time — the de-dupe key for one minute. */
function minuteKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function msToNextMinute(d: Date): number {
  return 60_000 - (d.getSeconds() * 1_000 + d.getMilliseconds());
}
