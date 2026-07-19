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
   * Fixed coalescing window for commit-time doorbells. Defaults to 25 ms: a
   * tight write burst becomes one cursor evaluation without compromising the
   * sub-second live path. Exposed only as a deterministic test seam.
   */
  nudgeDelayMs?: number;
  /**
   * Fired once per processed minute, BEFORE any fire (issue #351): the host's
   * hook for per-tick bookkeeping that has nothing to do with any one
   * automation — the missed-run ledger (`scheduler-ledger.ts`) and liveness
   * probing both hang off this rather than widening `Host`/`LocalScheduler`,
   * so an injected test double (`stubScheduler` et al.) never needs it.
   */
  onTick?: (at: Date) => void;
  /**
   * Fired only on active↔dormant transitions. Hosts use it to suppress stale
   * health while empty and reset the downtime baseline before schedules are
   * re-enabled, without writing a ledger every idle minute.
   */
  onDormancyChange?: (dormant: boolean, at: Date) => void | Promise<void>;
}

interface SchedulerEntry {
  readonly ref: string;
  readonly crons: readonly string[];
  /** Condition-trigger gates: the `every` cron + the trigger's index. */
  readonly watches: readonly {
    readonly expr: string;
    readonly index: number;
    readonly kind: 'condition' | 'data';
    readonly entities: readonly string[];
  }[];
}

/** `Host` + the lifecycle the owning server drives. */
export interface LocalScheduler extends Host {
  /**
   * Hint that committed provenance may be available. Data-trigger cursors
   * remain the source of truth; implementations coalesce bursts and evaluate
   * off-cycle without applying the minute cron gate.
   */
  nudge(entityTypes?: readonly string[]): void;
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
  private readonly nudgeDelayMs: number;
  private readonly onDormancyChange?: (dormant: boolean, at: Date) => void | Promise<void>;
  private boundary?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private lastFiredMinute?: string;
  private nudgeTimer?: ReturnType<typeof setTimeout>;
  private nudgeAll = false;
  private readonly nudgedEntityTypes = new Set<string>();
  private readonly watchEvaluations = new Map<
    string,
    { inFlight: Promise<void>; dirty: boolean }
  >();

  constructor(opts: InProcessSchedulerOptions) {
    this.fire = opts.fire;
    this.evaluate = opts.evaluate;
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError;
    this.onTick = opts.onTick;
    this.nudgeDelayMs = opts.nudgeDelayMs ?? 25;
    this.onDormancyChange = opts.onDormancyChange;
  }

  async register(row: Row): Promise<void> {
    const wasDormant = this.entries.size === 0;
    const entry = entryOf(row);
    // The host's toggle path: a disabled or trigger-less automation is
    // simply not scheduled.
    if (!row.enabled || (entry.crons.length === 0 && entry.watches.length === 0)) {
      this.entries.delete(row.ref);
      await this.notifyDormancyChange(wasDormant);
      return;
    }
    this.entries.set(row.ref, entry);
    await this.notifyDormancyChange(wasDormant);
  }

  async unregister(ref: string): Promise<void> {
    const wasDormant = this.entries.size === 0;
    this.entries.delete(ref);
    await this.notifyDormancyChange(wasDormant);
  }

  async list(): Promise<readonly string[]> {
    return [...this.entries.keys()].sort();
  }

  async reconcile(desired: ReadonlyArray<Row>): Promise<ReconcileResult> {
    const wasDormant = this.entries.size === 0;
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

    const previous = new Map(this.entries);
    this.entries.clear();
    for (const [ref, entry] of next) this.entries.set(ref, entry);
    // A fresh data trigger must establish its no-history watermark before
    // the next commit rings the doorbell. Otherwise that first doorbell is
    // consumed by evaluateDataTrigger's intentional bootstrap pull and the
    // first post-install write is missed. Await the bootstrap so a publisher
    // can treat a completed reconcile as a real readiness boundary.
    if (this.evaluate && (added.length > 0 || updated.length > 0)) {
      const changed = new Set([...added, ...updated]);
      try {
        await Promise.all(
          [...next.values()].flatMap((entry) =>
            changed.has(entry.ref)
              ? entry.watches
                  .filter((watch) => watch.kind === 'data')
                  .map((watch) => this.evaluateWatch(entry.ref, watch.index))
              : [],
          ),
        );
      } catch (err) {
        // A publisher may only treat reconcile as the readiness boundary when
        // bootstrap succeeded. Restore the previous registry so the next
        // reconcile retries the added/updated watcher instead of mistaking a
        // failed bootstrap for an already-settled entry.
        this.entries.clear();
        for (const [ref, entry] of previous) this.entries.set(ref, entry);
        throw err;
      }
    }
    await this.notifyDormancyChange(wasDormant);
    return { added: added.sort(), updated: updated.sort(), removed: removed.sort() };
  }

  private async notifyDormancyChange(wasDormant: boolean): Promise<void> {
    const dormant = this.entries.size === 0;
    if (dormant === wasDormant || !this.onDormancyChange) return;
    try {
      await this.onDormancyChange(dormant, this.now());
    } catch (err) {
      this.onError?.(err, '<scheduler-dormancy>');
    }
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
    // With no enabled schedules there is no missed-fire state to persist.
    // Skipping the host hook avoids a journal.db write every minute on the
    // common zero-automation gateway (#456 I3).
    if (this.entries.size === 0) return;
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

  /**
   * Ring the data-trigger doorbell. This deliberately bypasses
   * `lastFiredMinute`: the persisted provenance cursor makes duplicate or
   * reordered hints harmless, while a short fixed window coalesces a burst of
   * nearby vault commits into one evaluation pass. Per-trigger evaluation is
   * also single-flight with one dirty rerun, so a nudge racing the minute tick
   * cannot read and advance the same persisted cursor concurrently.
   */
  nudge(entityTypes?: readonly string[]): void {
    if (entityTypes === undefined) {
      this.nudgeAll = true;
      this.nudgedEntityTypes.clear();
    } else if (!this.nudgeAll) {
      for (const entityType of entityTypes) this.nudgedEntityTypes.add(entityType);
    }
    if (this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = undefined;
      const all = this.nudgeAll;
      const written = new Set(this.nudgedEntityTypes);
      this.nudgeAll = false;
      this.nudgedEntityTypes.clear();
      if (!this.evaluate) return;
      for (const entry of this.entries.values()) {
        for (const watch of entry.watches) {
          if (watch.kind !== 'data') continue;
          if (!all && !watch.entities.some((entity) => written.has(entity))) continue;
          this.evaluateSafely(entry.ref, watch.index);
        }
      }
    }, this.nudgeDelayMs);
    this.nudgeTimer.unref?.();
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
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = undefined;
    }
    this.nudgeAll = false;
    this.nudgedEntityTypes.clear();
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
    void this.evaluateWatch(ref, triggerIndex).catch((err) => this.onError?.(err, ref));
  }

  /**
   * Serialize one persisted watch cursor across cron and doorbell callers.
   * A caller arriving during evaluation marks one dirty rerun; any additional
   * arrivals collapse into that same rerun. The returned promise includes the
   * rerun and deliberately rejects so reconcile can fail its readiness gate;
   * fire-and-forget callers attach the diagnostic catch in evaluateSafely.
   */
  private evaluateWatch(ref: string, triggerIndex: number): Promise<void> {
    if (!this.evaluate) return Promise.resolve();
    const key = `${ref}\u0000${triggerIndex}`;
    const current = this.watchEvaluations.get(key);
    if (current) {
      current.dirty = true;
      return current.inFlight;
    }
    const state = { inFlight: Promise.resolve(), dirty: false };
    const run = async (): Promise<void> => {
      do {
        state.dirty = false;
        await this.evaluate?.(ref, triggerIndex);
      } while (state.dirty);
    };
    // Publish the single-flight state before invoking the evaluator: an
    // evaluator may synchronously cause another write/ring before its first
    // await, and that re-entrant caller must see this pass as in-flight.
    this.watchEvaluations.set(key, state);
    state.inFlight = run().finally(() => {
      if (this.watchEvaluations.get(key) === state) this.watchEvaluations.delete(key);
    });
    return state.inFlight;
  }
}

function entryOf(row: Row): SchedulerEntry {
  return {
    ref: row.ref,
    crons: cronTriggersOf(row.triggers).map((t) => t.expr),
    watches: watchTriggersOf(row.triggers).map(({ trigger, expr, index }) => ({
      expr,
      index,
      kind: trigger.kind,
      entities: trigger.kind === 'data' ? trigger.entities : [],
    })),
  };
}

function sameCrons(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((expr, i) => expr === b[i]);
}

function sameWatches(a: SchedulerEntry['watches'], b: SchedulerEntry['watches']): boolean {
  return (
    a.length === b.length &&
    a.every(
      (w, i) =>
        w.expr === b[i]!.expr &&
        w.index === b[i]!.index &&
        w.kind === b[i]!.kind &&
        w.entities.length === b[i]!.entities.length &&
        w.entities.every((entity, entityIndex) => entity === b[i]!.entities[entityIndex]),
    )
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
