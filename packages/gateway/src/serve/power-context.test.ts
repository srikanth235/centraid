import { describe, expect, it } from 'vitest';
import {
  evaluatePosture,
  parsePmset,
  PowerContextMonitor,
  type BatteryProbeResult,
  type CpuStealSample,
} from './power-context.js';

describe('evaluatePosture', () => {
  const base = {
    platform: 'linux' as NodeJS.Platform,
    hasBattery: true,
    percent: 80,
    charging: false,
    discharging: false,
    thermalPressure: null,
    stealPercent: null,
    source: 'os-probe' as const,
    updatedAt: 1,
  };

  it('discharging on battery defers with reason on-battery, kind battery', () => {
    const s = evaluatePosture({ ...base, discharging: true, percent: 80 });
    expect(s.reason).toBe('on-battery');
    expect(s.deferringBackgroundWork).toBe(true);
    expect(s.kind).toBe('battery');
    expect(s.battery).toEqual({ percent: 80, charging: false });
  });

  it('low battery floor (<20 and discharging) reports low-battery', () => {
    const s = evaluatePosture({ ...base, discharging: true, percent: 12 });
    expect(s.reason).toBe('low-battery');
    expect(s.deferringBackgroundWork).toBe(true);
  });

  it('low-battery outranks thermal when both apply', () => {
    const s = evaluatePosture({
      ...base,
      discharging: true,
      percent: 5,
      thermalPressure: 'critical',
    });
    expect(s.reason).toBe('low-battery');
  });

  it('thermal serious/critical defers even on mains', () => {
    for (const t of ['serious', 'critical'] as const) {
      const s = evaluatePosture({ ...base, discharging: false, thermalPressure: t });
      expect(s.reason).toBe('thermal');
      expect(s.deferringBackgroundWork).toBe(true);
      expect(s.kind).toBe('mains');
    }
  });

  it('thermal nominal/fair does not defer', () => {
    for (const t of ['nominal', 'fair'] as const) {
      const s = evaluatePosture({ ...base, discharging: false, thermalPressure: t });
      expect(s.reason).toBeNull();
      expect(s.deferringBackgroundWork).toBe(false);
    }
  });

  it('charging on mains does not defer', () => {
    const s = evaluatePosture({ ...base, discharging: false, charging: true });
    expect(s.reason).toBeNull();
    expect(s.kind).toBe('mains');
  });

  it('no battery on linux is a server; darwin/win32 are mains; battery is null', () => {
    expect(evaluatePosture({ ...base, hasBattery: false, platform: 'linux' }).kind).toBe('server');
    expect(evaluatePosture({ ...base, hasBattery: false, platform: 'darwin' }).kind).toBe('mains');
    expect(evaluatePosture({ ...base, hasBattery: false, platform: 'win32' }).kind).toBe('mains');
    expect(evaluatePosture({ ...base, hasBattery: false }).battery).toBeNull();
  });

  it('low floor needs a known percent — discharging with null percent is on-battery', () => {
    const s = evaluatePosture({ ...base, discharging: true, percent: null });
    expect(s.reason).toBe('on-battery');
  });
});

describe('parsePmset', () => {
  it('parses a discharging laptop', () => {
    const out =
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t62%; discharging; 3:12 remaining present: true";
    expect(parsePmset(out)).toEqual({
      present: true,
      percent: 62,
      charging: false,
      discharging: true,
    });
  });

  it('parses a charging laptop on AC', () => {
    const out =
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t90%; charging; 0:20 remaining present: true";
    const r = parsePmset(out);
    expect(r.present).toBe(true);
    expect(r.percent).toBe(90);
    expect(r.discharging).toBe(false);
    expect(r.charging).toBe(true);
  });

  it('reports no battery for a desktop Mac', () => {
    expect(parsePmset("Now drawing from 'AC Power'\n")).toEqual({
      present: false,
      percent: null,
      charging: null,
      discharging: null,
    });
  });
});

/** A monitor whose boot probe is resolved and awaited before the first snapshot. */
async function monitorWith(
  opts: {
    platform?: NodeJS.Platform;
    probe?: BatteryProbeResult | null;
    now?: () => number;
    steal?: () => CpuStealSample | null;
    onDeferringChange?: (deferring: boolean) => void;
  } = {},
): Promise<PowerContextMonitor> {
  const m = new PowerContextMonitor({
    platform: opts.platform ?? 'darwin',
    now: opts.now ?? (() => 0),
    probeBattery: async () => opts.probe ?? null,
    ...(opts.steal ? { readStealSample: opts.steal } : {}),
    ...(opts.onDeferringChange
      ? { onDeferringChange: (s) => opts.onDeferringChange!(s.deferringBackgroundWork) }
      : {}),
  });
  await m.ready;
  return m;
}

describe('PowerContextMonitor', () => {
  it('boot probe with no battery on darwin is mains, source os-probe, battery null', async () => {
    const m = await monitorWith({
      platform: 'darwin',
      probe: { present: false, percent: null, charging: null, discharging: null },
    });
    const s = m.snapshot();
    expect(s.kind).toBe('mains');
    expect(s.source).toBe('os-probe');
    expect(s.battery).toBeNull();
    expect(s.deferringBackgroundWork).toBe(false);
  });

  it('battery-absent null gates battery chrome even when a client push arrives', async () => {
    const m = await monitorWith({
      platform: 'darwin',
      probe: { present: false, percent: null, charging: null, discharging: null },
    });
    m.applyClientPush({ onBattery: false });
    // Desktop Mac: probe says no battery, so battery stays null (no chrome).
    expect(m.snapshot().battery).toBeNull();
  });

  it('a fresh client push supersedes the probe and marks source client-push', async () => {
    let t = 1_000;
    const m = await monitorWith({
      platform: 'darwin',
      now: () => t,
      probe: { present: true, percent: 90, charging: true, discharging: false },
    });
    m.applyClientPush({ onBattery: true, batteryPercent: 15 });
    const s = m.snapshot();
    expect(s.source).toBe('client-push');
    expect(s.reason).toBe('low-battery');
    expect(s.battery).toEqual({ percent: 15, charging: false });
  });

  it('client push decays after 120s and posture falls back to the probe', async () => {
    let t = 0;
    const m = await monitorWith({
      platform: 'darwin',
      now: () => t,
      probe: { present: true, percent: 95, charging: true, discharging: false },
    });
    m.applyClientPush({ onBattery: true, batteryPercent: 10 });
    expect(m.snapshot().reason).toBe('low-battery');
    t = 120_001;
    const s = m.snapshot();
    expect(s.source).toBe('os-probe');
    expect(s.reason).toBeNull();
    expect(s.battery).toEqual({ percent: 95, charging: true });
  });

  it('clearClientPush drops pushed state immediately', async () => {
    const m = await monitorWith({
      platform: 'darwin',
      probe: { present: true, percent: 90, charging: true, discharging: false },
    });
    m.applyClientPush({ onBattery: true, batteryPercent: 5 });
    expect(m.snapshot().reason).toBe('low-battery');
    m.clearClientPush();
    expect(m.snapshot().reason).toBeNull();
  });

  it('computes linux steal% from the delta between reads, at most every 60s', async () => {
    let t = 0;
    const samples: (CpuStealSample | null)[] = [
      { steal: 10, total: 1000 },
      { steal: 40, total: 1300 }, // Δsteal 30 / Δtotal 300 = 10%
    ];
    let i = 0;
    const m = await monitorWith({
      platform: 'linux',
      now: () => t,
      probe: { present: false, percent: null, charging: null, discharging: null },
      steal: () => samples[Math.min(i++, samples.length - 1)] ?? null,
    });
    // First snapshot at boot took sample[0]; no delta yet.
    expect(m.snapshot().stealPercent).toBeNull();
    t = 60_001;
    expect(m.snapshot().stealPercent).toBeCloseTo(10, 5);
  });

  it('steal is null on non-linux platforms', async () => {
    const m = await monitorWith({
      platform: 'darwin',
      probe: { present: false, percent: null, charging: null, discharging: null },
    });
    expect(m.snapshot().stealPercent).toBeNull();
  });

  it('tolerates a throwing boot probe — posture is none, never throws', async () => {
    const m = new PowerContextMonitor({
      platform: 'linux',
      now: () => 0,
      probeBattery: async () => {
        throw new Error('pmset exploded');
      },
    });
    await m.ready;
    const s = m.snapshot();
    expect(s.source).toBe('none');
    expect(s.deferringBackgroundWork).toBe(false);
    expect(s.battery).toBeNull();
  });

  it('fires onDeferringChange on the first true and on each toggle, not on boot false', async () => {
    let t = 0;
    const changes: boolean[] = [];
    const m = await monitorWith({
      platform: 'darwin',
      now: () => t,
      probe: { present: true, percent: 90, charging: true, discharging: false },
      onDeferringChange: (d) => changes.push(d),
    });
    m.snapshot(); // boot false — no fire
    expect(changes).toEqual([]);
    m.applyClientPush({ onBattery: true, batteryPercent: 50 });
    m.snapshot(); // false -> true
    m.clearClientPush();
    m.snapshot(); // true -> false
    expect(changes).toEqual([true, false]);
  });

  it('isDeferringBackgroundWork reflects the current posture', async () => {
    const m = await monitorWith({
      platform: 'darwin',
      probe: { present: true, percent: 90, charging: true, discharging: false },
    });
    expect(m.isDeferringBackgroundWork()).toBe(false);
    m.applyClientPush({ onBattery: true, batteryPercent: 50 });
    expect(m.isDeferringBackgroundWork()).toBe(true);
  });
});
