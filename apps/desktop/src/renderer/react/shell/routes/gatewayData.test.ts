import { describe, expect, it } from 'vitest';
import {
  ALERT_PRESETS,
  availabilityPct,
  buildOutageRows,
  formatAgo,
  formatDuration,
  formatUptime,
  thresholdLabel,
  type GatewayRuntimeSnapshot,
} from './gatewayData.js';

const T0 = Date.UTC(2026, 6, 11, 12, 0, 0); // Jul 11 2026, 12:00:00 UTC

const snapshot = (over: Partial<GatewayRuntimeSnapshot> = {}): GatewayRuntimeSnapshot => ({
  gatewayId: 'local',
  gatewayLabel: 'Local',
  gatewayKind: 'local',
  trackingSince: T0,
  status: 'up',
  statusSince: T0,
  lastCheckAt: T0 + 60_000,
  latencyMs: 3,
  checksTotal: 12,
  checksFailed: 0,
  samples: [],
  outages: [],
  alert: { enabled: true, thresholdSeconds: 120 },
  pollIntervalMs: 5000,
  ...over,
});

describe('formatting', () => {
  it('formatDuration spans magnitudes', () => {
    expect(formatDuration(4000)).toBe('4s');
    expect(formatDuration(200_000)).toBe('3m 20s');
    expect(formatDuration(7_500_000)).toBe('2h 05m');
  });

  it('formatUptime always carries seconds below a day', () => {
    expect(formatUptime(65_000)).toBe('1m 05s');
    expect(formatUptime(8_105_000)).toBe('2h 15m 05s');
    expect(formatUptime(93_600_000 * 3)).toBe('3d 06h');
  });

  it('formatAgo is now-relative', () => {
    expect(formatAgo(T0, T0 + 500)).toBe('just now');
    expect(formatAgo(T0, T0 + 3000)).toBe('3s ago');
    expect(formatAgo(T0, T0 + 120_000)).toBe('2m ago');
  });
});

describe('availabilityPct', () => {
  it('is undefined before the first probe', () => {
    expect(availabilityPct({ checksTotal: 0, checksFailed: 0 })).toBeUndefined();
  });
  it('is the answered-heartbeat share', () => {
    expect(availabilityPct({ checksTotal: 200, checksFailed: 1 })).toBeCloseTo(99.5);
  });
});

describe('buildOutageRows', () => {
  it('orders newest first, ticks the ongoing outage against now, and flags alerts', () => {
    const rows = buildOutageRows(
      snapshot({
        status: 'down',
        outages: [
          { startedAt: T0, endedAt: T0 + 30_000 },
          { startedAt: T0 + 100_000, alertedAt: T0 + 220_000 },
        ],
      }),
      T0 + 160_000,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ongoing).toBe(true);
    expect(rows[0]?.durationLabel).toBe('1m 00s');
    expect(rows[0]?.alerted).toBe(true);
    expect(rows[1]?.ongoing).toBe(false);
    expect(rows[1]?.durationLabel).toBe('30s');
    expect(rows[1]?.alerted).toBe(false);
  });
});

describe('alert presets', () => {
  it('carries the 2-minute default on the ladder', () => {
    expect(ALERT_PRESETS.some((p) => p.seconds === 120)).toBe(true);
  });
  it('labels off-ladder thresholds compactly', () => {
    expect(thresholdLabel(120)).toBe('2m');
    expect(thresholdLabel(45)).toBe('45s');
    expect(thresholdLabel(600)).toBe('10m');
  });
});
