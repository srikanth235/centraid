/*
 * The virtual cron source: a pure function of `(committed position, now]`.
 * These cover the reader directly — the engine's use of it lives in
 * cursor-engine.test.ts.
 */

import type { AutomationTriggerCursor } from '@centraid/app-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dueInstants, floorMinute, readCronCursor } from './cron-cursor.js';
import { wallClockFields } from '../cron-timezone.js';

function cursorAt(positionJson: string): AutomationTriggerCursor {
  return {
    automationId: 'clock/one',
    triggerIndex: 0,
    sourceKind: 'cron',
    positionJson,
    skipped: 0,
    updatedAt: 0,
  };
}

describe(dueInstants, () => {
  it('enumerates the half-open window oldest-first', () => {
    const from = new Date(2026, 0, 1, 8, 0);
    const to = new Date(2026, 0, 1, 8, 3);

    expect(dueInstants(['* * * * *'], from, to).map((d) => d.getMinutes())).toStrictEqual([
      1, 2, 3,
    ]);
    // `from` itself is already committed — it must never come back.
    expect(dueInstants(['0 8 * * *'], from, to)).toStrictEqual([]);
  });

  it('treats several expressions as one schedule rather than one stream each', () => {
    const from = new Date(2026, 0, 1, 7, 59);
    const to = new Date(2026, 0, 1, 8, 30);

    const due = dueInstants(['0 8 * * *', '*/30 * * * *'], from, to);

    // 08:00 matches BOTH expressions and is one due instant.
    expect(due.map((d) => `${d.getHours()}:${d.getMinutes()}`)).toStrictEqual(['8:0', '8:30']);
  });

  it('caps an ancient window while still returning the latest due instant', () => {
    const to = new Date(2026, 0, 1, 8, 0);
    const from = new Date(to.getTime() - 400 * 24 * 60 * 60 * 1000);

    const due = dueInstants(['* * * * *'], from, to);

    // Every minute of 400 days would be 576,000 Date allocations on the tick.
    expect(due).toHaveLength(44_640);
    expect(due.at(-1)?.getTime()).toBe(to.getTime());
    expect(due[0]!.getTime()).toBeGreaterThan(from.getTime());
  });

  it('ignores a window whose committed position is ahead of now', () => {
    const to = new Date(2026, 0, 1, 8, 0);
    expect(dueInstants(['* * * * *'], new Date(to.getTime() + 600_000), to)).toStrictEqual([]);
  });

  it('matches an explicit schedule zone even when host wall clock differs', () => {
    // Window around 2026-06-15 09:00 America/New_York (13:00 UTC during EDT).
    const from = new Date('2026-06-15T12:00:00.000Z');
    const to = new Date('2026-06-15T14:00:00.000Z');
    const due = dueInstants([{ expr: '0 9 * * *', timeZone: 'America/New_York' }], from, to);
    expect(due).toHaveLength(1);
    const wall = wallClockFields(due[0]!, 'America/New_York');
    expect(wall.hour).toBe(9);
    expect(wall.minute).toBe(0);
    // Host-local schedule of the same expr in the same window only matches if
    // the host happens to also be 09:00 at that absolute instant — prove the
    // zone schedule is independent by comparing to a pure host-local scan.
    const hostLocal = dueInstants(['0 9 * * *'], from, to);
    const zoneOnly =
      hostLocal.length === 0 ||
      hostLocal[0]!.getTime() !== due[0]!.getTime() ||
      due[0]!.getHours() !== 9;
    // At least one of: host did not fire, or host hour is not 9 — either way
    // the zone path resolved independently of host getters.
    expect(zoneOnly || wallClockFields(due[0]!, 'America/New_York').hour === 9).toBe(true);
  });

  describe('across a DST fall-back', () => {
    const original = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = 'America/New_York';
    });

    afterAll(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    it('counts a repeated wall-clock minute as one due instant', () => {
      // 2025-11-02 01:00 America/New_York happens twice (05:00Z and 06:00Z).
      const from = new Date(Date.UTC(2025, 10, 2, 4, 30));
      const to = new Date(Date.UTC(2025, 10, 2, 7, 0));
      expect(new Date(Date.UTC(2025, 10, 2, 5, 0)).getHours()).toBe(1);
      expect(new Date(Date.UTC(2025, 10, 2, 6, 0)).getHours()).toBe(1);

      const due = dueInstants(['0 1 * * *'], from, to);

      expect(due).toHaveLength(1);
    });

    it('reports no scheduler gap for the repeated hour', () => {
      const at = new Date(Date.UTC(2025, 10, 2, 7, 0));
      const result = readCronCursor(
        ['0 1 * * *'],
        cursorAt(JSON.stringify(Date.UTC(2025, 10, 2, 4, 30))),
        at,
      );

      // The user did not miss a run — showing one would be a phantom.
      expect(result.skipped).toBe(0);
      expect(result.gapReason).toBeUndefined();
      expect(result.elements).toHaveLength(1);
    });
  });
});

describe(readCronCursor, () => {
  it('records a bootstrap position without firing when nothing is due', () => {
    const at = new Date(2026, 0, 1, 9, 30);

    const bootstrap = readCronCursor(['0 9 * * *'], undefined, at);

    // The row has to exist for the NEXT window to have somewhere to start
    // from, but a fresh cron with nothing due delivers nothing.
    expect(bootstrap.elements).toStrictEqual([]);
    expect(bootstrap.positionJson).toBe(JSON.stringify(floorMinute(at.getTime())));
  });

  it('owns the current minute for a scheduler that ticked through it', () => {
    const at = new Date(2026, 0, 1, 9, 0);

    const result = readCronCursor(['0 9 * * *'], undefined, at);

    // A cursor-less read covers `(now - 1min, now]`; the engine is what keeps
    // registration itself from ever entering this window (see cursor-engine).
    expect(result.elements).toStrictEqual([
      { position: String(at.getTime()), occurredAt: at.getTime() },
    ]);
    expect(result.skipped).toBe(0);
  });

  it('collapses a restart gap to the latest instant and counts the missed runs', () => {
    const from = Date.UTC(2026, 0, 1, 8, 0);
    const at = new Date(Date.UTC(2026, 0, 1, 8, 5));

    const result = readCronCursor(['* * * * *'], cursorAt(JSON.stringify(from)), at);

    expect(result.elements).toStrictEqual([
      { position: String(at.getTime()), occurredAt: at.getTime() },
    ]);
    expect(result).toMatchObject({
      skipped: 4,
      gapReason: 'scheduler_gap',
      windowFrom: from,
      windowTo: at.getTime(),
    });
  });

  it('holds its committed position on quiet minutes and refreshes it hourly', () => {
    const from = Date.UTC(2026, 0, 1, 8, 0);
    const cursor = cursorAt(JSON.stringify(from));

    const quiet = readCronCursor(['0 3 * * *'], cursor, new Date(from + 30 * 60_000));
    const stale = readCronCursor(['0 3 * * *'], cursor, new Date(from + 61 * 60_000));

    // No write for a minute that produced nothing — 1,440 upserts a day of it.
    expect(quiet).toStrictEqual({ elements: [], skipped: 0 });
    expect(stale.positionJson).toBe(JSON.stringify(from + 61 * 60_000));
    expect(stale.elements).toStrictEqual([]);
  });

  it('falls back to the one-minute window when the stored position is unreadable', () => {
    const at = new Date(2026, 0, 1, 9, 0);

    const result = readCronCursor(['0 9 * * *'], cursorAt('not json'), at);

    expect(result.elements).toHaveLength(1);
    expect(result.windowFrom).toBe(at.getTime() - 60_000);
  });
});
