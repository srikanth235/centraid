import { describe, expect, it } from 'vitest';
import {
  applyProbe,
  clampAlertSeconds,
  DEFAULT_ALERT_SECONDS,
  evaluateAlert,
  formatDurationMs,
  initialRuntimeState,
  MAX_ALERT_SECONDS,
  MIN_ALERT_SECONDS,
  OUTAGE_CAP,
  SAMPLE_CAP,
  type GatewayProbe,
  type GatewayRuntimeState,
} from './gateway-monitor-core.js';

const GW = { id: 'local', label: 'Local', kind: 'local' as const };
const T0 = 1_000_000;

const ok = (at: number, extra: Partial<GatewayProbe> = {}): GatewayProbe => ({
  at,
  ok: true,
  latencyMs: 3,
  gatewayStartedAt: T0 - 60_000,
  gatewayUptimeMs: at - (T0 - 60_000),
  version: '0.1.0',
  schemaEpoch: 1,
  ...extra,
});
const fail = (at: number, detail = 'fetch failed'): GatewayProbe => ({ at, ok: false, detail });

const run = (probes: GatewayProbe[]): GatewayRuntimeState =>
  probes.reduce(applyProbe, initialRuntimeState(GW, T0));

describe('applyProbe', () => {
  it('establishes up on the first successful probe and carries identity fields', () => {
    const state = run([ok(T0 + 5000)]);
    expect(state.status).toBe('up');
    expect(state.statusSince).toBe(T0 + 5000);
    expect(state.checksTotal).toBe(1);
    expect(state.checksFailed).toBe(0);
    expect(state.version).toBe('0.1.0');
    expect(state.gatewayUptimeMs).toBe(65_000);
    expect(state.outages).toHaveLength(0);
  });

  it('opens an outage when the first-ever probe fails (down from the start)', () => {
    const state = run([fail(T0 + 5000)]);
    expect(state.status).toBe('down');
    expect(state.outages).toEqual([{ startedAt: T0 + 5000 }]);
    expect(state.lastError).toBe('fetch failed');
  });

  it('opens on up→down and closes on down→up, keeping last-known identity', () => {
    const state = run([ok(T0 + 5000), fail(T0 + 10_000), fail(T0 + 15_000), ok(T0 + 20_000)]);
    expect(state.status).toBe('up');
    expect(state.outages).toEqual([{ startedAt: T0 + 10_000, endedAt: T0 + 20_000 }]);
    expect(state.checksTotal).toBe(4);
    expect(state.checksFailed).toBe(2);
  });

  it('keeps the last-known version while down', () => {
    const state = run([ok(T0 + 5000), fail(T0 + 10_000)]);
    expect(state.version).toBe('0.1.0');
    expect(state.lastError).toBe('fetch failed');
  });

  it('does not restart statusSince on repeated same-status probes', () => {
    const state = run([fail(T0 + 5000), fail(T0 + 10_000)]);
    expect(state.statusSince).toBe(T0 + 5000);
    expect(state.outages).toHaveLength(1);
  });

  it('caps the sample ring and the outage log', () => {
    const probes: GatewayProbe[] = [];
    for (let i = 0; i < SAMPLE_CAP + 40; i += 2) {
      probes.push(fail(T0 + i * 1000), ok(T0 + (i + 1) * 1000));
    }
    const state = run(probes);
    expect(state.samples.length).toBeLessThanOrEqual(SAMPLE_CAP);
    expect(state.outages.length).toBeLessThanOrEqual(OUTAGE_CAP);
    // The ring keeps the most recent tail.
    expect(state.samples[state.samples.length - 1]?.at).toBe(probes[probes.length - 1]?.at);
  });
});

describe('evaluateAlert', () => {
  const config = { enabled: true, thresholdSeconds: DEFAULT_ALERT_SECONDS };

  it('stays quiet before the threshold', () => {
    const state = run([fail(T0)]);
    const { action } = evaluateAlert(state, config, T0 + 60_000);
    expect(action).toBeUndefined();
  });

  it('fires the down alert once the outage crosses the threshold, exactly once', () => {
    const state = run([fail(T0)]);
    const first = evaluateAlert(state, config, T0 + 120_000);
    expect(first.action).toEqual({ kind: 'down', downForMs: 120_000 });
    const second = evaluateAlert(first.state, config, T0 + 180_000);
    expect(second.action).toBeUndefined();
  });

  it('does not fire when alerts are disabled', () => {
    const state = run([fail(T0)]);
    const { action } = evaluateAlert(state, { ...config, enabled: false }, T0 + 999_000);
    expect(action).toBeUndefined();
  });

  it('fires the recovery notice only for an alerted outage, exactly once', () => {
    // Alerted outage → recovery notice on the up transition.
    let state = run([fail(T0)]);
    ({ state } = evaluateAlert(state, config, T0 + 120_000));
    state = applyProbe(state, ok(T0 + 150_000));
    const recovered = evaluateAlert(state, config, T0 + 150_000);
    expect(recovered.action).toEqual({ kind: 'recovered', outageMs: 150_000 });
    expect(evaluateAlert(recovered.state, config, T0 + 155_000).action).toBeUndefined();

    // Short, un-alerted outage → no recovery noise.
    const quiet = run([fail(T0), ok(T0 + 10_000)]);
    expect(evaluateAlert(quiet, config, T0 + 10_000).action).toBeUndefined();
  });

  it('delivers the recovery notice even if alerts were toggled off mid-outage', () => {
    let state = run([fail(T0)]);
    ({ state } = evaluateAlert(state, config, T0 + 120_000));
    state = applyProbe(state, ok(T0 + 200_000));
    const { action } = evaluateAlert(state, { ...config, enabled: false }, T0 + 200_000);
    expect(action).toEqual({ kind: 'recovered', outageMs: 200_000 });
  });

  it('no-ops with an empty outage log', () => {
    const state = run([ok(T0)]);
    expect(evaluateAlert(state, config, T0 + 5000).action).toBeUndefined();
  });
});

describe('clampAlertSeconds', () => {
  it('clamps into the valid range and rounds', () => {
    expect(clampAlertSeconds(1)).toBe(MIN_ALERT_SECONDS);
    expect(clampAlertSeconds(120.4)).toBe(120);
    expect(clampAlertSeconds(999_999)).toBe(MAX_ALERT_SECONDS);
  });
  it('rejects non-numeric garbage', () => {
    expect(clampAlertSeconds('120')).toBeUndefined();
    expect(clampAlertSeconds(Number.NaN)).toBeUndefined();
    expect(clampAlertSeconds(undefined)).toBeUndefined();
  });
});

describe('formatDurationMs', () => {
  it('formats across magnitudes', () => {
    expect(formatDurationMs(47_000)).toBe('47s');
    expect(formatDurationMs(200_000)).toBe('3m 20s');
    expect(formatDurationMs(7_500_000)).toBe('2h 05m');
    expect(formatDurationMs(100_800_000)).toBe('1d 4h');
  });
});
