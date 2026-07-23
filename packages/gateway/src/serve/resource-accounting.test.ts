import { describe, expect, it } from 'vitest';
import { ResourceAccounting } from './resource-accounting.js';

const HOUR_MS = 60 * 60 * 1000;

/** A ResourceAccounting whose clock, CPU, and RSS readers are all driven by tests. */
function makeAccounting(init?: {
  start?: number;
  rss?: () => number;
  cpu?: () => { user: number; system: number };
  worker?: () => { tasks: number; busyMs: number };
}) {
  let clock = init?.start ?? 1_000;
  const acc = new ResourceAccounting({
    now: () => clock,
    ...(init?.rss ? { rss: init.rss } : {}),
    ...(init?.cpu ? { cpuUsage: init.cpu } : {}),
    ...(init?.worker ? { workerPoolStats: init.worker } : {}),
  });
  return {
    acc,
    advance: (ms: number) => {
      clock += ms;
    },
    set: (ms: number) => {
      clock = ms;
    },
  };
}

describe('ResourceAccounting', () => {
  it('stamps sinceMs at construction and starts every subsystem at zero', () => {
    const { acc } = makeAccounting({ start: 5_000 });
    const snap = acc.snapshot();
    expect(snap.sinceMs).toBe(5_000);
    expect(snap.subsystems.replication).toEqual({ passes: 0, bytesReplicated: 0, busyMs: 0 });
    expect(snap.subsystems.backup).toEqual({ drains: 0, bytesUploaded: 0, busyMs: 0 });
    expect(snap.subsystems.sweeps).toEqual({ passes: 0, busyMs: 0 });
    expect(snap.subsystems.agentRuns).toEqual({ runs: 0, busyMs: 0, cpuSeconds: null });
  });

  it('accumulates replication, backup, sweep, and agent-run counters', () => {
    const { acc } = makeAccounting();
    acc.recordReplicationPass({ bytesReplicated: 100, durationMs: 10 });
    acc.recordReplicationPass({ bytesReplicated: 50, durationMs: 5 });
    acc.recordBackupDrain({ bytesUploaded: 2_048, durationMs: 40 });
    acc.recordSweepPass({ durationMs: 7 });
    acc.recordSweepPass({ durationMs: 3 });
    acc.recordAgentRun({ durationMs: 1_200 });

    const snap = acc.snapshot();
    expect(snap.subsystems.replication).toEqual({ passes: 2, bytesReplicated: 150, busyMs: 15 });
    expect(snap.subsystems.backup).toEqual({ drains: 1, bytesUploaded: 2_048, busyMs: 40 });
    expect(snap.subsystems.sweeps).toEqual({ passes: 2, busyMs: 10 });
    expect(snap.subsystems.agentRuns).toEqual({ runs: 1, busyMs: 1_200, cpuSeconds: null });
  });

  it('agentRuns.cpuSeconds stays null (no fabricated child rusage)', () => {
    const { acc } = makeAccounting();
    acc.recordAgentRun({ durationMs: 500 });
    acc.recordAgentRun({ durationMs: 500 });
    expect(acc.snapshot().subsystems.agentRuns.cpuSeconds).toBeNull();
  });

  it('clamps negative byte/duration inputs to zero (honest, never negative)', () => {
    const { acc } = makeAccounting();
    acc.recordReplicationPass({ bytesReplicated: -10, durationMs: -5 });
    acc.recordAgentRun({ durationMs: -100 });
    const snap = acc.snapshot();
    expect(snap.subsystems.replication).toEqual({ passes: 1, bytesReplicated: 0, busyMs: 0 });
    expect(snap.subsystems.agentRuns.busyMs).toBe(0);
  });

  it('derives cpuSecondsTotal from user+system microseconds and reports current rss', () => {
    let rss = 111;
    const { acc } = makeAccounting({
      cpu: () => ({ user: 1_500_000, system: 500_000 }),
      rss: () => rss,
    });
    rss = 222;
    const snap = acc.snapshot();
    expect(snap.process.cpuSecondsTotal).toBeCloseTo(2, 6);
    expect(snap.process.currentRssBytes).toBe(222);
  });

  it('peakRssBytes is monotonic across sample points and never falls back', () => {
    let rss = 1_000;
    const { acc } = makeAccounting({ rss: () => rss });
    rss = 5_000;
    acc.recordSweepPass({ durationMs: 1 }); // samples 5_000
    rss = 2_000;
    acc.recordSweepPass({ durationMs: 1 }); // samples 2_000, peak stays 5_000
    const snap = acc.snapshot(); // samples 2_000
    expect(snap.process.peakRssBytes).toBe(5_000);
    expect(snap.process.currentRssBytes).toBe(2_000);
  });

  it('reads worker-pool actuals live from the injected stats getter', () => {
    const { acc } = makeAccounting({ worker: () => ({ tasks: 12, busyMs: 3_400 }) });
    expect(acc.snapshot().subsystems.workerPool).toEqual({ tasks: 12, busyMs: 3_400 });
  });

  describe('backgroundTimerFiresLastHour', () => {
    it('is null before a full hour has elapsed since boot', () => {
      const { acc, advance } = makeAccounting({ start: 0 });
      acc.recordBackgroundTimerFire();
      advance(HOUR_MS - 1);
      expect(acc.snapshot().backgroundTimerFiresLastHour).toBeNull();
    });

    it('counts fires within the rolling hour once the first window elapses', () => {
      const { acc, advance } = makeAccounting({ start: 0 });
      acc.recordBackgroundTimerFire(); // t=0
      advance(HOUR_MS); // now t=HOUR_MS — window complete
      acc.recordBackgroundTimerFire(); // t=HOUR_MS
      // The t=0 fire is exactly one hour old and pruned; only the t=HOUR_MS fire remains.
      expect(acc.snapshot().backgroundTimerFiresLastHour).toBe(1);
    });

    it('prunes fires older than one hour out of the window', () => {
      const { acc, advance, set } = makeAccounting({ start: 0 });
      set(2 * HOUR_MS); // past the first-window gate
      acc.recordBackgroundTimerFire(); // t=2h
      advance(30 * 60 * 1000); // t=2.5h
      acc.recordBackgroundTimerFire(); // t=2.5h
      advance(40 * 60 * 1000); // t≈3.17h — the 2h fire is now >1h old
      const snap = acc.snapshot();
      expect(snap.backgroundTimerFiresLastHour).toBe(1);
    });
  });

  it('conforms to the fixed DTO shape', () => {
    const { acc } = makeAccounting();
    const snap = acc.snapshot();
    expect(Object.keys(snap).sort()).toEqual(
      ['backgroundTimerFiresLastHour', 'process', 'sinceMs', 'subsystems'].sort(),
    );
    expect(Object.keys(snap.subsystems).sort()).toEqual(
      ['agentRuns', 'backup', 'replication', 'sweeps', 'workerPool'].sort(),
    );
  });
});
