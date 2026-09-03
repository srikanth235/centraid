import { describe, expect, it } from "vitest";

import {
  applyComponentAlerts,
  applyProbe,
  clampAlertSeconds,
  DEFAULT_ALERT_SECONDS,
  DEFAULT_COMPONENT_ALERT_SECONDS,
  DEGRADED_LATENCY_MS,
  evaluateAlert,
  formatDurationMs,
  initialRuntimeState,
  isPendingBootProbe,
  MAX_ALERT_SECONDS,
  MIN_ALERT_SECONDS,
  OUTAGE_CAP,
  SAMPLE_CAP,
  SUSTAINED_LATENCY_SAMPLE_COUNT,
} from "./gateway-monitor-core.js";
import type {
  GatewayComponentIssue,
  GatewayProbe,
  GatewayRuntimeState,
} from "./gateway-monitor-core.js";
import { EXPECTED_PROTOCOL_VERSION } from "./version-handshake.js";

const GW = { id: "local", label: "Local", kind: "local" as const };
const T0 = 1_000_000;

const ok = (at: number, extra: Partial<GatewayProbe> = {}): GatewayProbe => ({
  at,
  ok: true,
  latencyMs: 3,
  gatewayStartedAt: T0 - 60_000,
  gatewayUptimeMs: at - (T0 - 60_000),
  version: "0.1.0",
  protocolVersion: EXPECTED_PROTOCOL_VERSION,
  ...extra,
});
const fail = (at: number, detail = "fetch failed"): GatewayProbe => ({
  at,
  ok: false,
  detail,
});

const run = (probes: GatewayProbe[]): GatewayRuntimeState =>
  probes.reduce(applyProbe, initialRuntimeState(GW, T0));

describe(applyProbe, () => {
  it("establishes up on the first successful probe and carries identity fields", () => {
    const state = run([ok(T0 + 5000)]);
    expect(state.status).toBe("up");
    expect(state.statusSince).toBe(T0 + 5000);
    expect(state.checksTotal).toBe(1);
    expect(state.checksFailed).toBe(0);
    expect(state.version).toBe("0.1.0");
    expect(state.gatewayUptimeMs).toBe(65_000);
    expect(state.outages).toHaveLength(0);
  });

  it("opens an outage when the first-ever probe fails (down from the start)", () => {
    const state = run([fail(T0 + 5000)]);
    expect(state.status).toBe("down");
    expect(state.outages).toStrictEqual([{ startedAt: T0 + 5000 }]);
    expect(state.lastError).toBe("fetch failed");
  });

  it("opens on up→down and closes on down→up, keeping last-known identity", () => {
    const state = run([
      ok(T0 + 5000),
      fail(T0 + 10_000),
      fail(T0 + 15_000),
      ok(T0 + 20_000),
    ]);
    expect(state.status).toBe("up");
    expect(state.outages).toStrictEqual([
      { startedAt: T0 + 10_000, endedAt: T0 + 20_000 },
    ]);
    expect(state.checksTotal).toBe(4);
    expect(state.checksFailed).toBe(2);
  });

  it("keeps the last-known version while down", () => {
    const state = run([ok(T0 + 5000), fail(T0 + 10_000)]);
    expect(state.version).toBe("0.1.0");
    expect(state.lastError).toBe("fetch failed");
  });

  it("does not restart statusSince on repeated same-status probes", () => {
    const state = run([fail(T0 + 5000), fail(T0 + 10_000)]);
    expect(state.statusSince).toBe(T0 + 5000);
    expect(state.outages).toHaveLength(1);
  });

  it("caps the sample ring and the outage log", () => {
    const probes: GatewayProbe[] = [];
    for (let i = 0; i < SAMPLE_CAP + 40; i += 2) {
      probes.push(fail(T0 + i * 1000), ok(T0 + (i + 1) * 1000));
    }
    const state = run(probes);
    expect(state.samples.length).toBeLessThanOrEqual(SAMPLE_CAP);
    expect(state.outages.length).toBeLessThanOrEqual(OUTAGE_CAP);
    expect(state.samples[state.samples.length - 1]?.at).toBe(
      probes[probes.length - 1]?.at
    );
  });
});

describe(evaluateAlert, () => {
  const config = { enabled: true, thresholdSeconds: DEFAULT_ALERT_SECONDS };

  it("stays quiet before the threshold", () => {
    const state = run([fail(T0)]);
    const { action } = evaluateAlert(state, config, T0 + 60_000);
    expect(action).toBeUndefined();
  });

  it("fires the down alert once the outage crosses the threshold, exactly once", () => {
    const state = run([fail(T0)]);
    const first = evaluateAlert(state, config, T0 + 120_000);
    expect(first.action).toStrictEqual({ kind: "down", downForMs: 120_000 });
    const second = evaluateAlert(first.state, config, T0 + 180_000);
    expect(second.action).toBeUndefined();
  });

  it("does not fire when alerts are disabled", () => {
    const state = run([fail(T0)]);
    const { action } = evaluateAlert(
      state,
      { ...config, enabled: false },
      T0 + 999_000
    );
    expect(action).toBeUndefined();
  });

  it("fires the recovery notice only for an alerted outage, exactly once", () => {
    let state = run([fail(T0)]);
    ({ state } = evaluateAlert(state, config, T0 + 120_000));
    state = applyProbe(state, ok(T0 + 150_000));
    const recovered = evaluateAlert(state, config, T0 + 150_000);
    expect(recovered.action).toStrictEqual({
      kind: "recovered",
      outageMs: 150_000,
    });
    expect(
      evaluateAlert(recovered.state, config, T0 + 155_000).action
    ).toBeUndefined();

    const quiet = run([fail(T0), ok(T0 + 10_000)]);
    expect(evaluateAlert(quiet, config, T0 + 10_000).action).toBeUndefined();
  });

  it("delivers the recovery notice even if alerts were toggled off mid-outage", () => {
    let state = run([fail(T0)]);
    ({ state } = evaluateAlert(state, config, T0 + 120_000));
    state = applyProbe(state, ok(T0 + 200_000));
    const { action } = evaluateAlert(
      state,
      { ...config, enabled: false },
      T0 + 200_000
    );
    expect(action).toStrictEqual({ kind: "recovered", outageMs: 200_000 });
  });

  it("no-ops with an empty outage log", () => {
    const state = run([ok(T0)]);
    expect(evaluateAlert(state, config, T0 + 5000).action).toBeUndefined();
  });
});

describe(clampAlertSeconds, () => {
  it("clamps into the valid range and rounds", () => {
    expect(clampAlertSeconds(1)).toBe(MIN_ALERT_SECONDS);
    expect(clampAlertSeconds(120.4)).toBe(120);
    expect(clampAlertSeconds(999_999)).toBe(MAX_ALERT_SECONDS);
  });
  it("rejects non-numeric garbage", () => {
    expect(clampAlertSeconds("120")).toBeUndefined();
    expect(clampAlertSeconds(Number.NaN)).toBeUndefined();
    expect(clampAlertSeconds(undefined)).toBeUndefined();
  });
});

describe(formatDurationMs, () => {
  it("formats across magnitudes", () => {
    expect(formatDurationMs(47_000)).toBe("47s");
    expect(formatDurationMs(200_000)).toBe("3m 20s");
    expect(formatDurationMs(7_500_000)).toBe("2h 05m");
    expect(formatDurationMs(100_800_000)).toBe("1d 4h");
  });
});

describe("applyProbe: health reconciliation", () => {
  it("carries the health probe status straight through when latency is fine", () => {
    const state = run([ok(T0, { healthStatus: "ok" })]);
    expect(state.healthStatus).toBe("ok");
    expect(state.latencyDegraded).toBe(false);
  });

  it("an error component wins outright, even if the probe itself is fast", () => {
    const state = run([
      ok(T0, {
        healthStatus: "error",
        componentIssues: [{ component: "vaults", status: "error" }],
      }),
    ]);
    expect(state.healthStatus).toBe("error");
    expect(state.componentIssues).toStrictEqual([
      { component: "vaults", status: "error" },
    ]);
  });

  it("a degraded component reads as degraded", () => {
    const state = run([
      ok(T0, {
        healthStatus: "degraded",
        componentIssues: [{ component: "outbox", status: "degraded" }],
      }),
    ]);
    expect(state.healthStatus).toBe("degraded");
  });

  it("sustained high latency downgrades an otherwise-ok probe to degraded", () => {
    const slow = (at: number): GatewayProbe =>
      ok(at, { healthStatus: "ok", latencyMs: DEGRADED_LATENCY_MS + 500 });
    expect(SUSTAINED_LATENCY_SAMPLE_COUNT).toBeGreaterThan(1);
    const one = run([slow(T0)]);
    expect(one.latencyDegraded).toBe(false);
    expect(one.healthStatus).toBe("ok");
    const probes = Array.from(
      { length: SUSTAINED_LATENCY_SAMPLE_COUNT },
      (_, i) => slow(T0 + i * 1000)
    );
    const sustained = run(probes);
    expect(sustained.latencyDegraded).toBe(true);
    expect(sustained.healthStatus).toBe("degraded");
  });

  it("a single fast probe breaks a latency streak", () => {
    const slow = (at: number): GatewayProbe =>
      ok(at, { healthStatus: "ok", latencyMs: DEGRADED_LATENCY_MS + 500 });
    const fast = (at: number): GatewayProbe =>
      ok(at, { healthStatus: "ok", latencyMs: 10 });
    const probes = [
      ...Array.from({ length: SUSTAINED_LATENCY_SAMPLE_COUNT }, (_, i) =>
        slow(T0 + i * 1000)
      ),
      fast(T0 + SUSTAINED_LATENCY_SAMPLE_COUNT * 1000),
    ];
    const state = run(probes);
    expect(state.latencyDegraded).toBe(false);
    expect(state.healthStatus).toBe("ok");
  });

  it("keeps the last-known healthStatus while the gateway is unreachable or omits status", () => {
    const withHealth = run([ok(T0, { healthStatus: "ok" })]);
    const stillOk = applyProbe(withHealth, fail(T0 + 5000));
    expect(stillOk.healthStatus).toBe("ok");
    const noStatus = applyProbe(
      withHealth,
      ok(T0 + 10_000, { healthStatus: undefined, componentIssues: undefined })
    );
    expect(noStatus.healthStatus).toBe("ok");
  });

  it("starts undefined before any health-capable probe has landed", () => {
    const state = run([ok(T0)]);
    expect(state.healthStatus).toBeUndefined();
  });
});

describe(applyComponentAlerts, () => {
  const config = {
    enabled: true,
    thresholdSeconds: DEFAULT_COMPONENT_ALERT_SECONDS,
  };
  const errorIssue = (
    component: string,
    message?: string
  ): GatewayComponentIssue => ({
    component,
    status: "error",
    ...(message ? { message } : {}),
  });

  it("tracks a newly-erroring component but stays quiet before the threshold", () => {
    let state = run([
      ok(T0, {
        healthStatus: "error",
        componentIssues: [errorIssue("vaults", "boom")],
      }),
    ]);
    ({ state } = applyComponentAlerts(state, T0, config));
    const { state: next, actions } = applyComponentAlerts(
      state,
      T0 + 60_000,
      config
    );
    expect(actions).toStrictEqual([]);
    expect(next.componentAlerts).toStrictEqual([
      { component: "vaults", sinceAt: T0, message: "boom" },
    ]);
  });

  it("fires once the component has been erroring past the threshold, exactly once", () => {
    let state = run([
      ok(T0, {
        healthStatus: "error",
        componentIssues: [errorIssue("vaults", "boom")],
      }),
    ]);
    ({ state } = applyComponentAlerts(state, T0, config));
    const first = applyComponentAlerts(
      state,
      T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000,
      config
    );
    expect(first.actions).toStrictEqual([
      {
        component: "vaults",
        message: "boom",
        downForMs: DEFAULT_COMPONENT_ALERT_SECONDS * 1000,
      },
    ]);
    const second = applyComponentAlerts(
      first.state,
      T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000 + 5000,
      config
    );
    expect(second.actions).toStrictEqual([]);
  });

  it("drops the record on recovery, re-arming the alert for a later re-error", () => {
    let state = run([
      ok(T0, {
        healthStatus: "error",
        componentIssues: [errorIssue("vaults")],
      }),
    ]);
    ({ state } = applyComponentAlerts(
      state,
      T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000,
      config
    ));
    expect(state.componentAlerts).toHaveLength(1);

    state = applyProbe(
      state,
      ok(T0 + 500_000, { healthStatus: "ok", componentIssues: [] })
    );
    ({ state } = applyComponentAlerts(state, T0 + 500_000, config));
    expect(state.componentAlerts).toStrictEqual([]);

    state = applyProbe(
      state,
      ok(T0 + 501_000, {
        healthStatus: "error",
        componentIssues: [errorIssue("vaults")],
      })
    );
    const reErrored = applyComponentAlerts(state, T0 + 501_000, config);
    expect(reErrored.actions).toStrictEqual([]);
    expect(reErrored.state.componentAlerts).toStrictEqual([
      { component: "vaults", sinceAt: T0 + 501_000 },
    ]);
  });

  it("does not fire when alerts are disabled", () => {
    const state = run([
      ok(T0, {
        healthStatus: "error",
        componentIssues: [errorIssue("vaults")],
      }),
    ]);
    const { actions } = applyComponentAlerts(
      state,
      T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000,
      {
        ...config,
        enabled: false,
      }
    );
    expect(actions).toStrictEqual([]);
  });

  it("tracks multiple components independently", () => {
    let state = run([
      ok(T0, {
        healthStatus: "error",
        componentIssues: [errorIssue("vaults"), errorIssue("outbox")],
      }),
    ]);
    ({ state } = applyComponentAlerts(state, T0, config));
    const { actions, state: next } = applyComponentAlerts(
      state,
      T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000,
      config
    );
    expect(actions.map((a) => a.component).sort()).toStrictEqual([
      "outbox",
      "vaults",
    ]);
    expect(next.componentAlerts).toHaveLength(2);
  });

  it("does not alert on a degraded (non-error) component", () => {
    const state = run([
      ok(T0, {
        healthStatus: "degraded",
        componentIssues: [{ component: "outbox", status: "degraded" }],
      }),
    ]);
    const { actions, state: next } = applyComponentAlerts(
      state,
      T0 + DEFAULT_COMPONENT_ALERT_SECONDS * 1000,
      config
    );
    expect(actions).toStrictEqual([]);
    expect(next.componentAlerts).toStrictEqual([]);
  });
});

describe(isPendingBootProbe, () => {
  const booting = (at: number, detail = "gateway URL not resolved yet") => ({
    ...fail(at, detail),
    bootPhase: true,
  });

  it("treats a synthesized boot-phase failure as pending, not as an outage", () => {
    expect(isPendingBootProbe(initialRuntimeState(GW, T0), booting(T0))).toBe(
      true
    );
  });

  it("the suppressed pair vanishes together: no outage opens, so none closes", () => {
    let state = initialRuntimeState(GW, T0);
    for (const at of [T0, T0 + 5000, T0 + 10_000])
      if (!isPendingBootProbe(state, booting(at)))
        state = applyProbe(state, booting(at));
    expect(state.status).toBe("unknown");
    expect(state.outages).toStrictEqual([]);

    state = applyProbe(state, ok(T0 + 15_000));
    expect(state.status).toBe("up");
    expect(state.outages).toStrictEqual([]);
  });

  it("a REAL failed probe is a real outage from the very first tick", () => {
    const state = initialRuntimeState(GW, T0);
    expect(isPendingBootProbe(state, fail(T0, "ECONNREFUSED"))).toBe(false);
    expect(applyProbe(state, fail(T0, "ECONNREFUSED")).outages).toHaveLength(1);
  });

  it("stops suppressing once this launch has resolved the gateway either way", () => {
    // Settings going unreadable AFTER the gateway has been seen is a genuine
    // regression, not boot noise — it must still fold through to `down`.
    const up = applyProbe(initialRuntimeState(GW, T0), ok(T0 + 5000));
    expect(
      isPendingBootProbe(up, booting(T0 + 10_000, "settings unavailable"))
    ).toBe(false);

    const down = applyProbe(initialRuntimeState(GW, T0), fail(T0 + 5000));
    expect(isPendingBootProbe(down, booting(T0 + 10_000))).toBe(false);
  });

  it("a successful probe is never pending, whatever the flag says", () => {
    expect(
      isPendingBootProbe(initialRuntimeState(GW, T0), {
        ...ok(T0),
        bootPhase: true,
      })
    ).toBe(false);
  });
});
