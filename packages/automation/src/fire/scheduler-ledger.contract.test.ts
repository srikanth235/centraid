import { describe, expect, it, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
import {
  computeMissedWindows,
  parseSchedulerLedgerSnapshot,
  recordSchedulerTick,
  SchedulerLedgerStore,
  SCHEDULER_LEDGER_AUTOMATION_ID,
  SCHEDULER_LEDGER_KEY,
  type MissedWindowEntry,
} from './scheduler-ledger.js';
import type { Trigger } from '../manifest/manifest.js';

const at = (h: number, mi: number, day = 1): Date => new Date(2026, 0, day, h, mi, 0, 0);

describe('computeMissedWindows', () => {
  it('returns nothing for an ordinary tick-to-tick gap (no outage)', () => {
    const missed = computeMissedWindows({
      lastTickAt: at(8, 0),
      now: at(8, 1),
      entries: [{ ref: 'a/one', crons: ['* * * * *'] }],
    });
    expect(missed).toEqual([]);
  });

  it('returns nothing for a fast-restart gap under the grace margin', () => {
    const missed = computeMissedWindows({
      lastTickAt: at(8, 0),
      now: new Date(at(8, 0).getTime() + 2.5 * 60_000), // +2.5min
      entries: [{ ref: 'a/one', crons: ['* * * * *'] }],
      graceMs: 3 * 60_000,
    });
    expect(missed).toEqual([]);
  });

  it('records ONE entry per automation for a gap spanning several missed fire times', () => {
    // Gap 08:00 -> 08:10 on a once-a-minute-ish schedule: many minutes
    // matched, but policy is one entry per automation per gap (earliest).
    const missed = computeMissedWindows({
      lastTickAt: at(8, 0),
      now: at(8, 10),
      entries: [{ ref: 'a/every-minute', crons: ['* * * * *'] }],
    });
    expect(missed).toHaveLength(1);
    expect(missed[0]!.automationRef).toBe('a/every-minute');
    // Earliest missed minute strictly after 08:00 is 08:01.
    expect(missed[0]!.scheduledFor).toBe(at(8, 1).toISOString());
    expect(missed[0]!.reason).toBe('gateway-down');
  });

  it('emits independent entries for multiple automations with different schedules', () => {
    const missed = computeMissedWindows({
      lastTickAt: at(8, 0),
      now: at(9, 0),
      entries: [
        { ref: 'a/every-5', crons: ['*/5 * * * *'] },
        { ref: 'a/at-08-30', crons: ['30 8 * * *'] },
        { ref: 'a/never', crons: ['0 3 * * *'] }, // doesn't match anywhere in the gap
      ],
    });
    const refs = missed.map((m) => m.automationRef).sort();
    expect(refs).toEqual(['a/at-08-30', 'a/every-5']);
    const every5 = missed.find((m) => m.automationRef === 'a/every-5')!;
    expect(every5.scheduledFor).toBe(at(8, 5).toISOString());
    const at0830 = missed.find((m) => m.automationRef === 'a/at-08-30')!;
    expect(at0830.scheduledFor).toBe(at(8, 30).toISOString());
  });

  it('skips automations with no cron triggers', () => {
    const missed = computeMissedWindows({
      lastTickAt: at(8, 0),
      now: at(8, 10),
      entries: [{ ref: 'a/watch-only', crons: [] }],
    });
    expect(missed).toEqual([]);
  });

  it('is a no-op when lastTickAt is at/after now (clock skew safety)', () => {
    const missed = computeMissedWindows({
      lastTickAt: at(9, 0),
      now: at(8, 0),
      entries: [{ ref: 'a/one', crons: ['* * * * *'] }],
    });
    expect(missed).toEqual([]);
  });

  /**
   * No-backfill property (#532): for any outage gap on a once-a-minute cron,
   * the ledger records at most ONE entry per automation (earliest missed fire),
   * never one per missed minute — the product stance is "record, don't backfill".
   */
  test('property: at most one missed entry per automation per gap (no backfill)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 180 }),
        fc.array(
          fc.tuple(
            fc.stringMatching(/^[a-z]{1,8}$/),
            fc.constantFrom('* * * * *', '*/5 * * * *', '0 * * * *'),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        (gapMinutes, rawEntries) => {
          // Deduplicate refs so the model matches product identity.
          const seen = new Set<string>();
          const entries = rawEntries
            .map(([id, cron]) => ({ ref: `a/${id}`, crons: [cron] as string[] }))
            .filter((e) => {
              if (seen.has(e.ref)) return false;
              seen.add(e.ref);
              return true;
            });
          const lastTickAt = at(8, 0);
          const now = new Date(lastTickAt.getTime() + gapMinutes * 60_000);
          const missed = computeMissedWindows({ lastTickAt, now, entries });
          const byRef = new Map<string, number>();
          for (const m of missed) {
            byRef.set(m.automationRef, (byRef.get(m.automationRef) ?? 0) + 1);
          }
          for (const [ref, count] of byRef) {
            expect(count).toBe(1);
            expect(ref.startsWith('a/')).toBe(true);
          }
          // Never more entries than automations (no per-minute backfill flood).
          expect(missed.length).toBeLessThanOrEqual(entries.length);
        },
      ),
      { numRuns: 48, seed: 53203 },
    );
  });

  test('property: every recorded scheduledFor is strictly after lastTickAt', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 120 }),
        fc.constantFrom('* * * * *', '*/5 * * * *'),
        (gapMinutes, cron) => {
          const lastTickAt = at(8, 0);
          const now = new Date(lastTickAt.getTime() + gapMinutes * 60_000);
          const missed = computeMissedWindows({
            lastTickAt,
            now,
            entries: [{ ref: 'a/one', crons: [cron] }],
          });
          for (const m of missed) {
            expect(new Date(m.scheduledFor).getTime()).toBeGreaterThan(lastTickAt.getTime());
            expect(new Date(m.scheduledFor).getTime()).toBeLessThan(now.getTime());
          }
        },
      ),
      { numRuns: 32, seed: 53231 },
    );
  });

  test('property: sub-grace gaps never emit misses', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 }), (minutes) => {
        // Default grace is 3 minutes — gaps under grace are quiet restarts.
        const lastTickAt = at(8, 0);
        const now = new Date(lastTickAt.getTime() + minutes * 60_000);
        const missed = computeMissedWindows({
          lastTickAt,
          now,
          entries: [{ ref: 'a/one', crons: ['* * * * *'] }],
          graceMs: 3 * 60_000,
        });
        expect(missed).toEqual([]);
      }),
      { numRuns: 16, seed: 53232 },
    );
  });

  test('property: empty registry never yields misses even across long gaps', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 10_000 }), (gapMinutes) => {
        const lastTickAt = at(8, 0);
        const now = new Date(lastTickAt.getTime() + gapMinutes * 60_000);
        expect(computeMissedWindows({ lastTickAt, now, entries: [] })).toEqual([]);
      }),
      { numRuns: 16, seed: 53233 },
    );
  });

  test('property: reason is always gateway-down for outage gaps', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 90 }), (gapMinutes) => {
        const lastTickAt = at(8, 0);
        const now = new Date(lastTickAt.getTime() + gapMinutes * 60_000);
        const missed = computeMissedWindows({
          lastTickAt,
          now,
          entries: [{ ref: 'a/one', crons: ['* * * * *'] }],
        });
        for (const m of missed) expect(m.reason).toBe('gateway-down');
      }),
      { numRuns: 20, seed: 53234 },
    );
  });
});

describe('parseSchedulerLedgerSnapshot', () => {
  it('returns an empty snapshot for absent/malformed input', () => {
    expect(parseSchedulerLedgerSnapshot(undefined)).toEqual({ missed: [] });
    expect(parseSchedulerLedgerSnapshot(null)).toEqual({ missed: [] });
    expect(parseSchedulerLedgerSnapshot('not json')).toEqual({ missed: [] });
    expect(parseSchedulerLedgerSnapshot('42')).toEqual({ missed: [] });
  });

  it('round-trips a well-formed snapshot', () => {
    const entry: MissedWindowEntry = {
      automationRef: 'a/one',
      scheduledFor: at(8, 1).toISOString(),
      recordedAt: at(8, 10).toISOString(),
      reason: 'gateway-down',
    };
    const json = JSON.stringify({ lastTickAt: at(8, 10).toISOString(), missed: [entry] });
    expect(parseSchedulerLedgerSnapshot(json)).toEqual({
      lastTickAt: at(8, 10).toISOString(),
      missed: [entry],
    });
  });
});

/** An in-memory `ConversationStore`-shaped fake — exercises the KV contract
 *  `SchedulerLedgerStore` relies on without spinning up real SQLite. */
function fakeConversationStore(): {
  stateGet: (automationId: string, key: string) => { valueJson: string } | undefined;
  stateSet: (automationId: string, key: string, valueJson: string, updatedAt: number) => void;
} {
  const kv = new Map<string, string>();
  return {
    stateGet: (automationId, key) => {
      const v = kv.get(`${automationId}:${key}`);
      return v === undefined ? undefined : { valueJson: v };
    },
    stateSet: (automationId, key, valueJson) => {
      kv.set(`${automationId}:${key}`, valueJson);
    },
  };
}

describe('SchedulerLedgerStore', () => {
  it('persists lastTickAt and accumulates missed entries under the reserved sentinel key', () => {
    const store = new SchedulerLedgerStore(fakeConversationStore());
    expect(store.load()).toEqual({ missed: [] });

    store.recordTick(at(8, 0));
    expect(store.load().lastTickAt).toBe(at(8, 0).toISOString());

    const entry: MissedWindowEntry = {
      automationRef: 'a/one',
      scheduledFor: at(8, 1).toISOString(),
      recordedAt: at(8, 10).toISOString(),
      reason: 'gateway-down',
    };
    store.recordMissed([entry]);
    expect(store.load().missed).toEqual([entry]);
    // recordTick after doesn't clobber missed entries.
    store.recordTick(at(8, 11));
    expect(store.load()).toEqual({ lastTickAt: at(8, 11).toISOString(), missed: [entry] });
  });

  it('bounds the missed-entry ring buffer', () => {
    const store = new SchedulerLedgerStore(fakeConversationStore());
    const many: MissedWindowEntry[] = Array.from({ length: 250 }, (_, i) => ({
      automationRef: `a/${i}`,
      scheduledFor: at(8, 0).toISOString(),
      recordedAt: at(8, 0).toISOString(),
      reason: 'gateway-down' as const,
    }));
    store.recordMissed(many);
    expect(store.load().missed).toHaveLength(200);
    // Bounded FIFO — the oldest entries drop first.
    expect(store.load().missed[0]!.automationRef).toBe('a/50');
  });

  it('uses the documented sentinel automation id + key (never collides with a real ref)', () => {
    const raw = fakeConversationStore();
    const store = new SchedulerLedgerStore(raw);
    store.recordTick(at(8, 0));
    expect(raw.stateGet(SCHEDULER_LEDGER_AUTOMATION_ID, SCHEDULER_LEDGER_KEY)).toBeDefined();
    // Real refs are always `<appId>/<id>` — the sentinel deliberately has no slash.
    expect(SCHEDULER_LEDGER_AUTOMATION_ID.includes('/')).toBe(false);
  });

  it('marks dormancy without advancing time and resets the baseline on wake', () => {
    const store = new SchedulerLedgerStore(fakeConversationStore());
    store.recordTick(at(8, 0));
    store.setDormant(true, at(8, 1));
    expect(store.load()).toEqual({
      lastTickAt: at(8, 0).toISOString(),
      dormant: true,
      missed: [],
    });
    store.setDormant(false, at(12, 0));
    expect(store.load()).toEqual({ lastTickAt: at(12, 0).toISOString(), missed: [] });
  });
});

describe('recordSchedulerTick', () => {
  const cron = (expr: string): readonly Trigger[] => [{ kind: 'cron', expr }];

  it('records nothing on the very first tick (no prior lastTickAt to compare against)', () => {
    const ledger = new SchedulerLedgerStore(fakeConversationStore());
    const missed = recordSchedulerTick({
      ledger,
      now: at(8, 0),
      automations: [{ ref: 'a/one', enabled: true, triggers: cron('* * * * *') }],
    });
    expect(missed).toEqual([]);
    expect(ledger.load().lastTickAt).toBe(at(8, 0).toISOString());
  });

  it('records nothing across ordinary consecutive ticks', () => {
    const ledger = new SchedulerLedgerStore(fakeConversationStore());
    recordSchedulerTick({ ledger, now: at(8, 0), automations: [] });
    const missed = recordSchedulerTick({ ledger, now: at(8, 1), automations: [] });
    expect(missed).toEqual([]);
  });

  it('detects a gap between two ticks and records one entry per enabled automation', () => {
    const ledger = new SchedulerLedgerStore(fakeConversationStore());
    recordSchedulerTick({
      ledger,
      now: at(8, 0),
      automations: [
        { ref: 'a/every-minute', enabled: true, triggers: cron('* * * * *') },
        { ref: 'a/disabled', enabled: false, triggers: cron('* * * * *') },
      ],
    });

    // The gateway "restarts" 20 minutes later — a real outage gap.
    const missed = recordSchedulerTick({
      ledger,
      now: at(8, 20),
      automations: [
        { ref: 'a/every-minute', enabled: true, triggers: cron('* * * * *') },
        { ref: 'a/disabled', enabled: false, triggers: cron('* * * * *') },
      ],
    });

    expect(missed).toHaveLength(1);
    expect(missed[0]!.automationRef).toBe('a/every-minute');
    expect(ledger.load().missed).toEqual(missed);
    expect(ledger.load().lastTickAt).toBe(at(8, 20).toISOString());
  });

  it('never records for a disabled-only registry even across a real gap', () => {
    const ledger = new SchedulerLedgerStore(fakeConversationStore());
    recordSchedulerTick({
      ledger,
      now: at(8, 0),
      automations: [{ ref: 'a/off', enabled: false, triggers: cron('* * * * *') }],
    });
    const missed = recordSchedulerTick({
      ledger,
      now: at(9, 0),
      automations: [{ ref: 'a/off', enabled: false, triggers: cron('* * * * *') }],
    });
    expect(missed).toEqual([]);
  });

  test('property: recordSchedulerTick never backfills disabled automations', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 120 }), (gapMinutes) => {
        const ledger = new SchedulerLedgerStore(fakeConversationStore());
        recordSchedulerTick({
          ledger,
          now: at(8, 0),
          automations: [
            { ref: 'a/on', enabled: true, triggers: cron('* * * * *') },
            { ref: 'a/off', enabled: false, triggers: cron('* * * * *') },
          ],
        });
        const later = new Date(at(8, 0).getTime() + gapMinutes * 60_000);
        const missed = recordSchedulerTick({
          ledger,
          now: later,
          automations: [
            { ref: 'a/on', enabled: true, triggers: cron('* * * * *') },
            { ref: 'a/off', enabled: false, triggers: cron('* * * * *') },
          ],
        });
        expect(missed.every((m) => m.automationRef === 'a/on')).toBe(true);
        expect(missed.some((m) => m.automationRef === 'a/off')).toBe(false);
        // One entry max per enabled automation per gap.
        expect(missed.filter((m) => m.automationRef === 'a/on').length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 24, seed: 53235 },
    );
  });

  test('property: successive ordinary ticks accumulate zero misses', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), (ticks) => {
        const ledger = new SchedulerLedgerStore(fakeConversationStore());
        const automations = [{ ref: 'a/one', enabled: true, triggers: cron('* * * * *') }] as const;
        for (let i = 0; i < ticks; i += 1) {
          const missed = recordSchedulerTick({
            ledger,
            now: at(8, i),
            automations: [...automations],
          });
          expect(missed).toEqual([]);
        }
      }),
      { numRuns: 16, seed: 53236 },
    );
  });
});
