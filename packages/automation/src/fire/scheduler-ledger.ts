/**
 * Missed-automation-run ledger (issue #351 tier 2) — the honest record a
 * downtime used to leave nothing behind for.
 *
 * The in-process cron scheduler (`in-process-scheduler.ts`) fires enabled
 * cron automations only while it runs; minutes the timer slept through are
 * silently skipped, by design (n8n semantics, no backfill — issue #149).
 * That's a defensible product stance, but until now it left NO record
 * anywhere that anything was missed — an outage and a quiet day looked
 * identical from the outside. The outbox, by contrast, self-heals on its
 * next drain pass because its queue survives downtime; a cron fire has no
 * queue, so a missed minute is gone for good — the least this module can do
 * is say so.
 *
 * Mechanism: on every tick, the scheduler's host persists `lastTickAt`
 * (`recordSchedulerTick`, called from `InProcessScheduler`'s `onTick`
 * hook). The SAME call compares the just-loaded `lastTickAt` against `now`
 * first — if the gap is wide enough to be a real outage rather than
 * ordinary minute-to-minute cadence or a fast restart, it records ONE entry
 * per automation whose cron would have fired somewhere in the gap, then
 * persists `now` as the new `lastTickAt`. On the ordinary path (gap ≈ one
 * scheduler period) this is a fast no-op — the expensive scan only runs
 * right after a real gap closes.
 *
 * Policy, deliberately: **one entry per automation PER GAP** (the earliest
 * missed fire-time), not one per missed minute. A week-long outage on a
 * once-a-minute cron would otherwise mint thousands of rows for no
 * actionable gain — "the gateway was down and this automation missed at
 * least one run since <time>" is the useful signal; the exact missed-minute
 * count is derivable from the gap itself if anyone needs it.
 *
 * Recorded, NOT retro-executed: whether to backfill the actual runs is a
 * product decision this module deliberately does not make (unlike the
 * outbox, which DOES catch up automatically — the asymmetry is real and is
 * exactly what this ledger makes legible instead of papering over).
 *
 * Persistence rides `automation_state` (`ConversationStore.stateGet` /
 * `stateSet`) — the same per-vault KV trigger cursors and `ctx.state`
 * already live in (see `store.ts`'s header: "mutable WORKING state... it
 * stays for pragmatics"). No schema change: a reserved sentinel automation
 * id (`__scheduler`, which can never collide with a real `<appId>/<id>`
 * ref — those always contain `/`) keys one JSON blob per vault.
 */

import type { ConversationStore } from '@centraid/app-engine';
import { cronMatches } from './cron-match.js';
import { cronTriggersOf, type Trigger } from '../manifest/manifest.js';

/** Reserved `automation_state.automation_id` — never a real ref (those contain `/`). */
export const SCHEDULER_LEDGER_AUTOMATION_ID = '__scheduler';
/** Reserved `automation_state.key` for the one ledger blob. */
export const SCHEDULER_LEDGER_KEY = 'ledger';

/** Ring-buffer bound so a long-neglected gateway doesn't grow this unbounded. */
const MAX_MISSED_ENTRIES = 200;

/** One automation's earliest missed fire inside one downtime gap. */
export interface MissedWindowEntry {
  readonly automationRef: string;
  /** ISO minute the cron would have fired — the EARLIEST match in the gap. */
  readonly scheduledFor: string;
  /** ISO instant the gap was detected (the tick that noticed it). */
  readonly recordedAt: string;
  readonly reason: 'gateway-down';
}

export interface SchedulerLedgerSnapshot {
  /** ISO instant of the scheduler's last processed tick. Absent before the first tick ever lands. */
  readonly lastTickAt?: string;
  /** Missed-window entries, oldest-first, bounded to `MAX_MISSED_ENTRIES`. */
  readonly missed: readonly MissedWindowEntry[];
}

const EMPTY_SNAPSHOT: SchedulerLedgerSnapshot = { missed: [] };

/**
 * Parse a stored `automation_state.value_json` blob back into a snapshot.
 * Tolerant of absence (fresh vault, never ticked) and corruption (never
 * throws) — a ledger read is diagnostics, not a load-bearing path.
 */
export function parseSchedulerLedgerSnapshot(
  json: string | null | undefined,
): SchedulerLedgerSnapshot {
  if (!json) return EMPTY_SNAPSHOT;
  try {
    const parsed = JSON.parse(json) as Partial<SchedulerLedgerSnapshot>;
    return {
      ...(typeof parsed.lastTickAt === 'string' ? { lastTickAt: parsed.lastTickAt } : {}),
      missed: Array.isArray(parsed.missed) ? (parsed.missed as MissedWindowEntry[]) : [],
    };
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

/** `automation_state`-backed persistence for one vault's scheduler ledger. */
export class SchedulerLedgerStore {
  constructor(private readonly store: ConversationStore) {}

  load(): SchedulerLedgerSnapshot {
    const entry = this.store.stateGet(SCHEDULER_LEDGER_AUTOMATION_ID, SCHEDULER_LEDGER_KEY);
    return parseSchedulerLedgerSnapshot(entry?.valueJson);
  }

  private write(snapshot: SchedulerLedgerSnapshot): void {
    this.store.stateSet(
      SCHEDULER_LEDGER_AUTOMATION_ID,
      SCHEDULER_LEDGER_KEY,
      JSON.stringify(snapshot),
      Date.now(),
    );
  }

  recordTick(at: Date): void {
    const current = this.load();
    this.write({ ...current, lastTickAt: at.toISOString() });
  }

  recordMissed(entries: readonly MissedWindowEntry[]): void {
    if (entries.length === 0) return;
    const current = this.load();
    const merged = [...current.missed, ...entries].slice(-MAX_MISSED_ENTRIES);
    this.write({ ...current, missed: merged });
  }
}

/**
 * Longest gap `computeMissedWindows` scans minute-by-minute — caps
 * worst-case CPU for a very long-neglected gateway. Beyond this, only the
 * most recent window is scanned; the ledger still gets an honest "something
 * was missed" entry, just anchored to the most recent week rather than the
 * true first missed minute of a months-long gap (a corner case not worth
 * the extra scan cost).
 */
const MAX_SCAN_MS = 7 * 24 * 60 * 60 * 1000;
const PERIOD_MS = 60_000;

export interface ComputeMissedWindowsOptions {
  readonly lastTickAt: Date;
  readonly now: Date;
  readonly entries: readonly { readonly ref: string; readonly crons: readonly string[] }[];
  /**
   * Minimum gap to treat as a real outage rather than jitter or a fast
   * restart. Defaults to 3 scheduler periods (3 min) — comfortably above
   * normal tick cadence, comfortably below "the gateway was actually down".
   */
  readonly graceMs?: number;
}

/**
 * Pure: one `MissedWindowEntry` per automation whose cron matches some
 * whole minute strictly inside `(lastTickAt, now)` — the window the
 * scheduler slept through. Returns `[]` when the gap doesn't exceed
 * `graceMs` (ordinary minute-to-minute cadence, or a fast restart, is not
 * an "outage").
 */
export function computeMissedWindows(opts: ComputeMissedWindowsOptions): MissedWindowEntry[] {
  const grace = opts.graceMs ?? PERIOD_MS * 3;
  const gapMs = opts.now.getTime() - opts.lastTickAt.getTime();
  if (gapMs <= grace) return [];

  const scanStartMs = Math.max(opts.lastTickAt.getTime(), opts.now.getTime() - MAX_SCAN_MS);
  const nowMinuteMs = floorToMinute(opts.now.getTime());
  const recordedAt = opts.now.toISOString();
  const out: MissedWindowEntry[] = [];
  for (const entry of opts.entries) {
    if (entry.crons.length === 0) continue;
    let scheduledForMs: number | undefined;
    // Earliest-only: stop at the first matching minute so a long gap costs
    // at most `min(gap, MAX_SCAN_MS) / PERIOD_MS` cronMatches calls per
    // automation, not a full scan when the automation fires often.
    for (let t = floorToMinute(scanStartMs) + PERIOD_MS; t < nowMinuteMs; t += PERIOD_MS) {
      const candidate = new Date(t);
      if (entry.crons.some((expr) => cronMatches(expr, candidate))) {
        scheduledForMs = t;
        break;
      }
    }
    if (scheduledForMs !== undefined) {
      out.push({
        automationRef: entry.ref,
        scheduledFor: new Date(scheduledForMs).toISOString(),
        recordedAt,
        reason: 'gateway-down',
      });
    }
  }
  return out;
}

function floorToMinute(ms: number): number {
  return Math.floor(ms / PERIOD_MS) * PERIOD_MS;
}

export interface RecordSchedulerTickOptions {
  readonly ledger: SchedulerLedgerStore;
  readonly now: Date;
  /** The vault's live automation registry (the same rows `reconcile()` sees) — only `enabled` ones count. */
  readonly automations: readonly {
    readonly ref: string;
    readonly enabled: boolean;
    readonly triggers: readonly Trigger[];
  }[];
  readonly graceMs?: number;
}

/**
 * One scheduler tick's ledger bookkeeping: compare the persisted
 * `lastTickAt` against `now`, record any missed windows the gap implies,
 * then persist `now` as the new `lastTickAt`. Safe to call every tick — the
 * normal ~60s gap never exceeds `graceMs`, so this is a fast no-op on every
 * ordinary minute; only a real gap (gateway restart) does real work.
 * Returns the entries just recorded (empty on the common path).
 */
export function recordSchedulerTick(
  opts: RecordSchedulerTickOptions,
): readonly MissedWindowEntry[] {
  const snapshot = opts.ledger.load();
  let missed: readonly MissedWindowEntry[] = [];
  if (snapshot.lastTickAt) {
    const lastTickAt = new Date(snapshot.lastTickAt);
    if (!Number.isNaN(lastTickAt.getTime())) {
      missed = computeMissedWindows({
        lastTickAt,
        now: opts.now,
        entries: opts.automations
          .filter((a) => a.enabled)
          .map((a) => ({ ref: a.ref, crons: cronTriggersOf(a.triggers).map((t) => t.expr) })),
        ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
      });
      if (missed.length > 0) opts.ledger.recordMissed(missed);
    }
  }
  opts.ledger.recordTick(opts.now);
  return missed;
}
