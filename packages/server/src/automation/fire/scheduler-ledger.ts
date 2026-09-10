// Missed-automation-run ledger (#351): cron fires only while the scheduler
// runs and there is no backfill (#149), so without this an outage and a quiet
// day look alike. Entries are RECORDED, never retro-executed. One entry per
// automation PER GAP, not per missed minute.

import { cronTriggersOf } from "../manifest/manifest.js";
import type { Trigger } from "../manifest/manifest.js";
import { cronMatches } from "./cron-match.js";

export const SCHEDULER_LEDGER_AUTOMATION_ID = "__scheduler";
export const SCHEDULER_LEDGER_KEY = "ledger";

/** Ring-buffer bound: a neglected gateway must not grow this unbounded. */
const MAX_MISSED_ENTRIES = 200;

export interface MissedWindowEntry {
  readonly automationRef: string;
  readonly scheduledFor: string;
  readonly recordedAt: string;
  readonly reason: "gateway-down";
}

export interface SchedulerLedgerSnapshot {
  readonly lastTickAt?: string;
  readonly dormant?: boolean;
  readonly missed: readonly MissedWindowEntry[];
}

const EMPTY_SNAPSHOT: SchedulerLedgerSnapshot = { missed: [] };

/** Never throws: a ledger read is diagnostics. */
export function parseSchedulerLedgerSnapshot(
  json: string | null | undefined
): SchedulerLedgerSnapshot {
  if (!json) return EMPTY_SNAPSHOT;
  try {
    const parsed = JSON.parse(json) as Partial<SchedulerLedgerSnapshot>;
    return {
      ...(typeof parsed.lastTickAt === "string"
        ? { lastTickAt: parsed.lastTickAt }
        : {}),
      ...(typeof parsed.dormant === "boolean"
        ? { dormant: parsed.dormant }
        : {}),
      missed: Array.isArray(parsed.missed)
        ? (parsed.missed as MissedWindowEntry[])
        : [],
    };
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

export interface SchedulerLedgerKv {
  stateGet: (
    automationId: string,
    key: string
  ) => { valueJson: string } | undefined;
  stateSet: (
    automationId: string,
    key: string,
    valueJson: string,
    updatedAt: number
  ) => void;
  /**
   * READ-MODIFY-WRITE, ATOMICALLY (#1014, B9). The whole ledger is one JSON
   * blob under one key, so a `recordTick` and a `recordMissed` that
   * interleaved each read the same snapshot and the second write erased the
   * first — the missed-run record an outage exists to leave behind, lost to
   * the tick that noticed the outage. Optional so an injected KV in a test
   * needs only the two accessors; absent means "no transaction available",
   * which is the behaviour this replaces, never worse.
   */
  runInTransaction?: <T>(fn: () => T) => T;
}

export class SchedulerLedgerStore {
  constructor(private readonly store: SchedulerLedgerKv) {}

  /** Every mutation below is one read-modify-write, and takes this door. */
  private update(
    mutate: (current: SchedulerLedgerSnapshot) => SchedulerLedgerSnapshot | null
  ): void {
    const apply = (): void => {
      const next = mutate(this.load());
      if (next !== null) this.write(next);
    };
    if (this.store.runInTransaction) this.store.runInTransaction(apply);
    else apply();
  }

  load(): SchedulerLedgerSnapshot {
    const entry = this.store.stateGet(
      SCHEDULER_LEDGER_AUTOMATION_ID,
      SCHEDULER_LEDGER_KEY
    );
    return parseSchedulerLedgerSnapshot(entry?.valueJson);
  }

  private write(snapshot: SchedulerLedgerSnapshot): void {
    this.store.stateSet(
      SCHEDULER_LEDGER_AUTOMATION_ID,
      SCHEDULER_LEDGER_KEY,
      JSON.stringify(snapshot),
      Date.now()
    );
  }

  recordTick(at: Date): void {
    this.update((current) => {
      const { dormant: _dormant, ...active } = current;
      return { ...active, lastTickAt: at.toISOString() };
    });
  }

  setDormant(dormant: boolean, at: Date): void {
    this.update((current) => {
      if (dormant) return { ...current, dormant: true };
      const { dormant: _dormant, ...active } = current;
      return { ...active, lastTickAt: at.toISOString() };
    });
  }

  recordMissed(entries: readonly MissedWindowEntry[]): void {
    if (entries.length === 0) return;
    this.update((current) => ({
      ...current,
      missed: [...current.missed, ...entries].slice(-MAX_MISSED_ENTRIES),
    }));
  }
}

/** Caps worst-case CPU; beyond it the entry anchors to the recent window, not
 *  the true first missed minute. */
const MAX_SCAN_MS = 7 * 24 * 60 * 60 * 1000;
const PERIOD_MS = 60_000;

export interface ComputeMissedWindowsOptions {
  readonly lastTickAt: Date;
  readonly now: Date;
  readonly entries: readonly {
    readonly ref: string;
    readonly crons: readonly string[];
    readonly cronTimeZones?: readonly (string | undefined)[];
  }[];
  /** Below this a gap is jitter, not an outage. */
  readonly graceMs?: number;
}

/** One entry per automation whose cron matches a minute strictly inside
 *  `(lastTickAt, now)`. */
export function computeMissedWindows(
  opts: ComputeMissedWindowsOptions
): MissedWindowEntry[] {
  const grace = opts.graceMs ?? PERIOD_MS * 3;
  const gapMs = opts.now.getTime() - opts.lastTickAt.getTime();
  if (gapMs <= grace) return [];

  const scanStartMs = Math.max(
    opts.lastTickAt.getTime(),
    opts.now.getTime() - MAX_SCAN_MS
  );
  const nowMinuteMs = floorToMinute(opts.now.getTime());
  const recordedAt = opts.now.toISOString();
  const out: MissedWindowEntry[] = [];
  for (const entry of opts.entries) {
    if (entry.crons.length === 0) continue;
    let scheduledForMs: number | undefined;
    // Earliest-only, so an often-firing automation costs no full scan.
    for (
      let t = floorToMinute(scanStartMs) + PERIOD_MS;
      t < nowMinuteMs;
      t += PERIOD_MS
    ) {
      const candidate = new Date(t);
      if (
        entry.crons.some((expr, i) =>
          cronMatches(expr, candidate, entry.cronTimeZones?.[i])
        )
      ) {
        scheduledForMs = t;
        break;
      }
    }
    if (scheduledForMs !== undefined) {
      out.push({
        automationRef: entry.ref,
        scheduledFor: new Date(scheduledForMs).toISOString(),
        recordedAt,
        reason: "gateway-down",
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
  readonly automations: readonly {
    readonly ref: string;
    readonly enabled: boolean;
    readonly triggers: readonly Trigger[];
  }[];
  readonly graceMs?: number;
}

export function recordSchedulerTick(
  opts: RecordSchedulerTickOptions
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
          .map((a) => {
            const crons = cronTriggersOf(a.triggers);
            return {
              ref: a.ref,
              crons: crons.map((t) => t.expr),
              cronTimeZones: crons.map((t) => t.tz),
            };
          }),
        ...(opts.graceMs === undefined ? {} : { graceMs: opts.graceMs }),
      });
      if (missed.length > 0) opts.ledger.recordMissed(missed);
    }
  }
  opts.ledger.recordTick(opts.now);
  return missed;
}
