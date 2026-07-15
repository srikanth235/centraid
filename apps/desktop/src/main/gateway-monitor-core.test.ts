import { describe, expect, it } from 'vitest';
import {
  applyComponentAlerts,
  applyProbe,
  applyVersionSkewAlert,
  clampAlertSeconds,
  DEFAULT_ALERT_SECONDS,
  DEFAULT_COMPONENT_ALERT_SECONDS,
  DEGRADED_LATENCY_MS,
  evaluateAlert,
  formatDurationMs,
  initialRuntimeState,
  MAX_ALERT_SECONDS,
  MIN_ALERT_SECONDS,
  OUTAGE_CAP,
  SAMPLE_CAP,
  SUSTAINED_LATENCY_SAMPLE_COUNT,
  type GatewayComponentIssue,
  type GatewayProbe,
  type GatewayRuntimeState,
} from './gateway-monitor-core.js';
import { EXPECTED_GATEWAY_VERSION, EXPECTED_SCHEMA_EPOCH } from './version-handshake.js';

const GW = { id: 'local', label: 'Local', kind: 'local' as const };
const REMOTE_GW = { id: 'remote-1', label: 'VPS', kind: 'remote' as const };
const T0 = 1_000_000;

const ok = (at: number, extra: Partial<GatewayProbe> = {}): GatewayProbe => ({
  at,
  ok: true,
  latencyMs: 3,
  gatewayStartedAt: T0 - 60_000,
  gatewayUptimeMs: at - (T0 - 60_000),
  version: '0.1.0',
  schemaEpoch: EXPECTED_SCHEMA_EPOCH,
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

describe('applyProbe: health reconciliation', () => {
  it('carries the health probe status straight through when latency is fine', () => {
    const state = run([ok(T0, { healthStatus: 'ok' })]);
    expect(state.healthStatus).toBe('ok');
    expect(state.latencyDegraded).toBe(false);
  });

  it('an error component wins outright, even if the probe itself is fast', () => {
    const state = run([
      ok(T0, {
        healthStatus: 'error',
        componentIssues: [{ component: 'vaults', status: 'error' }],
      }),
    ]);
    expect(state.healthStatus).toBe('error');
    expect(state.componentIssues).toEqual([{ component: 'vaults', status: 'error' }]);
  });

  it('a degraded component reads as degraded', () => {
    const state = run([
      ok(T0, {
        healthStatus: 'degraded',
        componentIssues: [{ component: 'outbox', status: 'degraded' }],
      }),
    ]);
    expect(state.healthStatus).toBe('degraded');
  });

  it('sustained high latency downgrades an otherwise-ok probe to degraded', () => {
    const slow = (at: number): GatewayProbe =>
      ok(at, { healthStatus: 'ok', latencyMs: DEGRADED_LATENCY_MS + 500 });
    expect(SUSTAINED_LATENCY_SAMPLE_COUNT).toBeGreaterThan(1);
    // One slow probe alone isn't "sustained".
    const one = run([slow(T0)]);
    expect(one.latencyDegraded).toBe(false);
    expect(one.healthStatus).toBe('ok');
    // A full run of consecutive slow, successful probes is.
    const probes = Array.from({ length: SUSTAINED_LATENCY_SAMPLE_COUNT }, (_, i) =>
      slow(T0 + i * 1000),
    );
    const sustained = run(probes);
    expect(sustained.latencyDegraded).toBe(true);
    expect(sustained.healthStatus).toBe('degraded');
  });

  it('a single fast probe breaks a latency streak', () => {
    const slow = (at: number): GatewayProbe =>
      ok(at, { healthStatus: 'ok', latencyMs: DEGRADED_LATENCY_MS + 500 });
    const fast = (at: number): GatewayProbe => ok(at, { healthStatus: 'ok', latencyMs: 10 });
    const probes = [
      ...Array.from({ length: SUSTAINED_LATENCY_SAMPLE_COUNT }, (_, i) => slow(T0 + i * 1000)),
      fast(T0 + SUSTAINED_LATENCY_SAMPLE_COUNT * 1000),
    ];
    const state = run(probes);
    expect(state.latencyDegraded).toBe(false);
    expect(state.healthStatus).toBe('ok');
  });

  it('keeps the last-known healthStatus while the gateway is unreachable or the probe falls back to /info', () => {
    const withHealth = run([ok(T0, { healthStatus: 'ok' })]);
    const stillOk = applyProbe(withHealth, fail(T0 + 5000));
    expect(stillOk.healthStatus).toBe('ok');
    // A probe that reached the gateway via the /info fallback (no healthStatus
    // opinion) doesn't clobber the last-known health reconciliation either.
    const infoFallback = applyProbe(
      withHealth,
      ok(T0 + 10_000, { healthStatus: undefined, componentIssues: undefined }),
    );
    expect(infoFallback.healthStatus).toBe('ok');
  });

  it('starts undefined before any health-capable probe has landed', () => {
    const state = run([ok(T0)]);
    expect(state.healthStatus).toBeUndefined();
  });
});

describe('applyComponentAlerts', () => {
  const config = { enabled: true, thresholdSeconds: DEFAULT_COMPONENT_ALERT_SECONDS };
  const errorIssue = (component: string, message?: string): GatewayComponentIssue => ({
    component,
    status: 'error',
    ...(message ? { message } : {}),
  });

  it('tracks a newly-erroring component but stays quiet before the threshold', () => {
    let state = run([
      ok(T0, { healthStatus: 'error', componentIssues: [errorIssue('vaults', 'boom')] }),
    ]);
    // First observation (same tick as the probe, T0) creates the record;
    // a later tick, still erroring but short of the threshold, stays quiet.
    ({ state } = applyComponentAlerts(state, T0, config));
    const { state: next, actions } = applyComponentAlerts(state, T0 + 60_000, config);
    expect(actions).toEqual([]);
    expect(next.componentAlerts).toEqual([{ component: 'vaults', sinceAt: T0, message: 'boom' }]);
  });

  it('fires once the component has been erroring past the threshold, exactly once', () => {
    let state = run([
      ok(T0, { healthStatus: 'error', componentIssues: [errorIssue('vaults', 'boom')] }),
    ]);
    ({ state } = applyComponentAlerts(state, T0, config));
    const first = applyComponentAlerts(state, T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000, config);
    expect(first.actions).toEqual([
      { component: 'vaults', message: 'boom', downForMs: DEFAULT_COMPONENT_ALERT_SECONDS * 1000 },
    ]);
    const second = applyComponentAlerts(
      first.state,
      T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000 + 5000,
      config,
    );
    expect(second.actions).toEqual([]);
  });

  it('drops the record on recovery, re-arming the alert for a later re-error', () => {
    let state = run([ok(T0, { healthStatus: 'error', componentIssues: [errorIssue('vaults')] })]);
    ({ state } = applyComponentAlerts(state, T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000, config));
    expect(state.componentAlerts).toHaveLength(1);

    // Recovers — the record is dropped.
    state = applyProbe(state, ok(T0 + 500_000, { healthStatus: 'ok', componentIssues: [] }));
    ({ state } = applyComponentAlerts(state, T0 + 500_000, config));
    expect(state.componentAlerts).toEqual([]);

    // Re-errors — starts a fresh window, doesn't immediately re-fire.
    state = applyProbe(
      state,
      ok(T0 + 501_000, { healthStatus: 'error', componentIssues: [errorIssue('vaults')] }),
    );
    const reErrored = applyComponentAlerts(state, T0 + 501_000, config);
    expect(reErrored.actions).toEqual([]);
    expect(reErrored.state.componentAlerts).toEqual([
      { component: 'vaults', sinceAt: T0 + 501_000 },
    ]);
  });

  it('does not fire when alerts are disabled', () => {
    const state = run([ok(T0, { healthStatus: 'error', componentIssues: [errorIssue('vaults')] })]);
    const { actions } = applyComponentAlerts(state, T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000, {
      ...config,
      enabled: false,
    });
    expect(actions).toEqual([]);
  });

  it('tracks multiple components independently', () => {
    let state = run([
      ok(T0, {
        healthStatus: 'error',
        componentIssues: [errorIssue('vaults'), errorIssue('outbox')],
      }),
    ]);
    ({ state } = applyComponentAlerts(state, T0, config));
    const { actions, state: next } = applyComponentAlerts(
      state,
      T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000,
      config,
    );
    expect(actions.map((a) => a.component).sort()).toEqual(['outbox', 'vaults']);
    expect(next.componentAlerts).toHaveLength(2);
  });

  it('does not alert on a degraded (non-error) component', () => {
    const state = run([
      ok(T0, {
        healthStatus: 'degraded',
        componentIssues: [{ component: 'outbox', status: 'degraded' }],
      }),
    ]);
    const { actions, state: next } = applyComponentAlerts(
      state,
      T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000,
      config,
    );
    expect(actions).toEqual([]);
    expect(next.componentAlerts).toEqual([]);
  });
});

describe('applyProbe: version handshake (issue #351, wave 2)', () => {
  const runRemote = (probes: GatewayProbe[]): GatewayRuntimeState =>
    probes.reduce(applyProbe, initialRuntimeState(REMOTE_GW, T0));

  it('never judges a local gateway — versionSkew stays undefined', () => {
    const state = run([ok(T0, { version: '9.9.9', schemaEpoch: 99 })]);
    expect(state.versionSkew).toBeUndefined();
  });

  it('a matching remote gateway reads as not skewed', () => {
    const state = runRemote([
      ok(T0, { version: EXPECTED_GATEWAY_VERSION, schemaEpoch: EXPECTED_SCHEMA_EPOCH }),
    ]);
    expect(state.versionSkew).toEqual({
      skewed: false,
      gatewayVersion: EXPECTED_GATEWAY_VERSION,
      gatewaySchemaEpoch: EXPECTED_SCHEMA_EPOCH,
      clientVersion: EXPECTED_GATEWAY_VERSION,
      clientSchemaEpoch: EXPECTED_SCHEMA_EPOCH,
    });
  });

  it('a mismatched version or schema epoch reads as skewed', () => {
    const badVersion = runRemote([
      ok(T0, { version: '9.9.9', schemaEpoch: EXPECTED_SCHEMA_EPOCH }),
    ]);
    expect(badVersion.versionSkew).toMatchObject({ skewed: true, gatewayVersion: '9.9.9' });

    const badEpoch = runRemote([
      ok(T0, { version: EXPECTED_GATEWAY_VERSION, schemaEpoch: EXPECTED_SCHEMA_EPOCH + 1 }),
    ]);
    expect(badEpoch.versionSkew).toMatchObject({
      skewed: true,
      gatewaySchemaEpoch: EXPECTED_SCHEMA_EPOCH + 1,
    });
  });

  it('keeps the last-known verdict across a failed probe or an /info-fallback probe', () => {
    const skewed = runRemote([ok(T0, { version: '9.9.9', schemaEpoch: EXPECTED_SCHEMA_EPOCH })]);
    const stillSkewed = applyProbe(skewed, fail(T0 + 5000));
    expect(stillSkewed.versionSkew).toMatchObject({ skewed: true, gatewayVersion: '9.9.9' });

    const fallback = applyProbe(
      skewed,
      ok(T0 + 10_000, { version: undefined, schemaEpoch: undefined }),
    );
    expect(fallback.versionSkew).toMatchObject({ skewed: true, gatewayVersion: '9.9.9' });
  });
});

describe('applyVersionSkewAlert', () => {
  const config = { enabled: true, thresholdSeconds: DEFAULT_ALERT_SECONDS };
  const runRemote = (probes: GatewayProbe[]): GatewayRuntimeState =>
    probes.reduce(applyProbe, initialRuntimeState(REMOTE_GW, T0));

  it('fires immediately on a skewed remote gateway — no threshold wait', () => {
    const state = runRemote([ok(T0, { version: '9.9.9', schemaEpoch: EXPECTED_SCHEMA_EPOCH })]);
    const { action } = applyVersionSkewAlert(state, config, T0);
    expect(action).toEqual({ gatewayVersion: '9.9.9', gatewaySchemaEpoch: EXPECTED_SCHEMA_EPOCH });
  });

  it('de-dupes — does not refire on a later tick while still skewed', () => {
    let state = runRemote([ok(T0, { version: '9.9.9', schemaEpoch: EXPECTED_SCHEMA_EPOCH })]);
    ({ state } = applyVersionSkewAlert(state, config, T0));
    const second = applyVersionSkewAlert(state, config, T0 + 60_000);
    expect(second.action).toBeUndefined();
  });

  it('does not fire when alerts are disabled', () => {
    const state = runRemote([ok(T0, { version: '9.9.9', schemaEpoch: EXPECTED_SCHEMA_EPOCH })]);
    const { action } = applyVersionSkewAlert(state, { ...config, enabled: false }, T0);
    expect(action).toBeUndefined();
  });

  it('does not fire for a matching (not skewed) remote gateway', () => {
    const state = runRemote([
      ok(T0, { version: EXPECTED_GATEWAY_VERSION, schemaEpoch: EXPECTED_SCHEMA_EPOCH }),
    ]);
    expect(applyVersionSkewAlert(state, config, T0).action).toBeUndefined();
  });

  it('never fires for a local gateway (versionSkew always undefined)', () => {
    const state = run([ok(T0, { version: '9.9.9', schemaEpoch: 99 })]);
    expect(applyVersionSkewAlert(state, config, T0).action).toBeUndefined();
  });

  it('re-arms once the gateway stops reporting skew, then re-fires on a later mismatch', () => {
    let state = runRemote([ok(T0, { version: '9.9.9', schemaEpoch: EXPECTED_SCHEMA_EPOCH })]);
    ({ state } = applyVersionSkewAlert(state, config, T0));
    expect(state.versionSkewAlertedAt).toBe(T0);

    // Both sides get upgraded to match — skew clears, the marker drops.
    state = applyProbe(
      state,
      ok(T0 + 10_000, { version: EXPECTED_GATEWAY_VERSION, schemaEpoch: EXPECTED_SCHEMA_EPOCH }),
    );
    ({ state } = applyVersionSkewAlert(state, config, T0 + 10_000));
    expect(state.versionSkewAlertedAt).toBeUndefined();

    // A later re-skew fires again.
    state = applyProbe(
      state,
      ok(T0 + 20_000, { version: '10.0.0', schemaEpoch: EXPECTED_SCHEMA_EPOCH }),
    );
    const refired = applyVersionSkewAlert(state, config, T0 + 20_000);
    expect(refired.action).toEqual({
      gatewayVersion: '10.0.0',
      gatewaySchemaEpoch: EXPECTED_SCHEMA_EPOCH,
    });
  });
});
