import { describe, expect, it } from 'vitest';
import {
  deriveStorageMetrics,
  type FreshnessClocks,
  type StorageMetricsInput,
} from './storage-metrics.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_000 * DAY; // arbitrary fixed reference clock

function clocks(overrides: Partial<FreshnessClocks> = {}): FreshnessClocks {
  return {
    lastAckedWalSegmentAt: NOW,
    outboxDrainedWatermarkAt: NOW,
    lastRegisteredSnapshotAt: NOW,
    lastSuccessfulVerificationAt: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<StorageMetricsInput> = {}): StorageMetricsInput {
  return {
    now: NOW,
    freshness: { declaredCadenceMs: DAY, clocks: clocks() },
    retention: { kind: 'ladder', keepAllDays: 7, dailyDays: 30, weeklyDays: 90 },
    usage: { backup: { bytesStored: 100, quotaBytes: 1000 } },
    restoreCostClass: 'free-egress',
    ...overrides,
  };
}

describe('freshness', () => {
  it('is green when all clocks are within 1× cadence', () => {
    const m = deriveStorageMetrics(input());
    expect(m.freshness.status).toBe('green');
    expect(m.freshness.tMs).toBe(NOW);
    expect(m.freshness.ageMs).toBe(0);
  });

  it('worst clock wins — T is the OLDEST of the four', () => {
    const oldest = NOW - 5 * HOUR;
    const m = deriveStorageMetrics(
      input({
        now: NOW,
        freshness: {
          declaredCadenceMs: DAY,
          clocks: clocks({
            lastRegisteredSnapshotAt: oldest,
            lastAckedWalSegmentAt: NOW - 1 * HOUR,
          }),
        },
      }),
    );
    expect(m.freshness.tMs).toBe(oldest);
    expect(m.freshness.ageMs).toBe(5 * HOUR);
    expect(m.freshness.status).toBe('green'); // 5h < 24h cadence
  });

  it('is unknown when ANY clock is missing (unproven edge)', () => {
    for (const key of [
      'lastAckedWalSegmentAt',
      'outboxDrainedWatermarkAt',
      'lastRegisteredSnapshotAt',
      'lastSuccessfulVerificationAt',
    ] as const) {
      const m = deriveStorageMetrics(
        input({
          freshness: { declaredCadenceMs: DAY, clocks: clocks({ [key]: null }) },
        }),
      );
      expect(m.freshness.status).toBe('unknown');
      expect(m.freshness.tMs).toBeNull();
      expect(m.freshness.ageMs).toBeNull();
    }
  });

  it('echoes the four input clocks for the diagnostics disclosure', () => {
    const c = clocks({ lastAckedWalSegmentAt: NOW - 3 * HOUR });
    const m = deriveStorageMetrics(input({ freshness: { declaredCadenceMs: DAY, clocks: c } }));
    expect(m.freshness.clocks).toEqual(c);
    expect(m.freshness.declaredCadenceMs).toBe(DAY);
  });

  describe('threshold edges', () => {
    const at = (ageMs: number): ReturnType<typeof deriveStorageMetrics>['freshness'] =>
      deriveStorageMetrics(
        input({
          now: NOW,
          freshness: {
            declaredCadenceMs: DAY,
            clocks: clocks({ lastAckedWalSegmentAt: NOW - ageMs }),
          },
        }),
      ).freshness;

    it('green exactly at 1× cadence (inclusive)', () => {
      expect(at(DAY).status).toBe('green');
    });
    it('yellow just past 1× cadence', () => {
      expect(at(DAY + 1).status).toBe('yellow');
    });
    it('yellow exactly at 2× cadence (inclusive)', () => {
      expect(at(2 * DAY).status).toBe('yellow');
    });
    it('red just past 2× cadence', () => {
      expect(at(2 * DAY + 1).status).toBe('red');
    });
  });
});

describe('recovery window', () => {
  it('N days = the ladder daily rung', () => {
    const m = deriveStorageMetrics(
      input({ retention: { kind: 'ladder', keepAllDays: 7, dailyDays: 30, weeklyDays: 90 } }),
    );
    expect(m.recoveryWindow.days).toBe(30);
  });

  it('is null when the provider promises no retention', () => {
    const m = deriveStorageMetrics(input({ retention: { kind: 'none' } }));
    expect(m.recoveryWindow.days).toBeNull();
    expect(m.recoveryWindow.retention).toEqual({ kind: 'none' });
  });
});

describe('privacy', () => {
  it('is a structural constant — sealed bytes, zero key custody', () => {
    const m = deriveStorageMetrics(input());
    expect(m.privacy.sealedBytes).toBe(true);
    expect(m.privacy.keyCustody).toBe('client-only');
    expect(typeof m.privacy.description).toBe('string');
  });
});

describe('cost', () => {
  it('aggregates bytesStored across ALL store classes', () => {
    const m = deriveStorageMetrics(
      input({
        usage: {
          backup: { bytesStored: 100, quotaBytes: 1000 },
          cas: { bytesStored: 250, quotaBytes: 1000 },
          derived: { bytesStored: 50, quotaBytes: 1000 },
        },
      }),
    );
    expect(m.cost.bytesStored).toBe(400);
    expect(m.cost.quotaBytes).toBe(1000);
    expect(m.cost.fractionUsed).toBeCloseTo(0.4);
    expect(m.cost.metered).toBe(true);
  });

  it('treats absent store keys as zero bytes', () => {
    const m = deriveStorageMetrics(
      input({ usage: { cas: { bytesStored: 42, quotaBytes: null } } }),
    );
    expect(m.cost.bytesStored).toBe(42);
  });

  it('is unmetered when no store reports a quota', () => {
    const m = deriveStorageMetrics(
      input({ usage: { backup: { bytesStored: 100, quotaBytes: null } } }),
    );
    expect(m.cost.quotaBytes).toBeNull();
    expect(m.cost.fractionUsed).toBeNull();
    expect(m.cost.metered).toBe(false);
  });

  it('takes the largest reported quota when stores disagree', () => {
    const m = deriveStorageMetrics(
      input({
        usage: {
          backup: { bytesStored: 100, quotaBytes: 500 },
          cas: { bytesStored: 100, quotaBytes: 2000 },
        },
      }),
    );
    expect(m.cost.quotaBytes).toBe(2000);
    expect(m.cost.bytesStored).toBe(200);
    expect(m.cost.fractionUsed).toBeCloseTo(0.1);
  });

  it('is zeroed and unmetered when usage is null (no poll yet)', () => {
    const m = deriveStorageMetrics(input({ usage: null }));
    expect(m.cost).toEqual({
      bytesStored: 0,
      quotaBytes: null,
      fractionUsed: null,
      metered: false,
    });
  });

  it('reports fractionUsed null (not Infinity) for a zero quota', () => {
    const m = deriveStorageMetrics(
      input({ usage: { backup: { bytesStored: 100, quotaBytes: 0 } } }),
    );
    // quota 0 is metered-but-degenerate; never divide by zero.
    expect(m.cost.fractionUsed).toBeNull();
  });
});

describe('exit', () => {
  it('export is always available and restoreCostClass passes through honestly', () => {
    const free = deriveStorageMetrics(input({ restoreCostClass: 'free-egress' }));
    expect(free.exit).toEqual({ exportAlwaysAvailable: true, restoreCostClass: 'free-egress' });
    const metered = deriveStorageMetrics(input({ restoreCostClass: 'metered-egress' }));
    expect(metered.exit.restoreCostClass).toBe('metered-egress');
  });
});

it('is pure — same input yields deeply-equal output', () => {
  const i = input();
  expect(deriveStorageMetrics(i)).toEqual(deriveStorageMetrics(i));
});
