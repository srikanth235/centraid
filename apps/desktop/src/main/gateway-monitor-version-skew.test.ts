import { describe, expect, it } from "vitest";

import {
  applyProbe,
  applyVersionSkewAlert,
  DEFAULT_ALERT_SECONDS,
  initialRuntimeState,
  type GatewayProbe,
  type GatewayRuntimeState,
} from "./gateway-monitor-core.js";
import {
  EXPECTED_GATEWAY_VERSION,
  EXPECTED_SCHEMA_EPOCH,
} from "./version-handshake.js";

type GatewayIdentity = Parameters<typeof initialRuntimeState>[0];

const LOCAL_GW: GatewayIdentity = {
  id: "local",
  label: "Local",
  kind: "local",
};
const REMOTE_GW: GatewayIdentity = {
  id: "remote-1",
  label: "VPS",
  kind: "remote",
};
const T0 = 1_000_000;

const ok = (at: number, extra: Partial<GatewayProbe> = {}): GatewayProbe => ({
  at,
  ok: true,
  latencyMs: 3,
  gatewayStartedAt: T0 - 60_000,
  gatewayUptimeMs: at - (T0 - 60_000),
  version: "0.1.0",
  schemaEpoch: EXPECTED_SCHEMA_EPOCH,
  ...extra,
});
const fail = (at: number): GatewayProbe => ({
  at,
  ok: false,
  detail: "fetch failed",
});
const run = (probes: GatewayProbe[], gateway = LOCAL_GW): GatewayRuntimeState =>
  probes.reduce(applyProbe, initialRuntimeState(gateway, T0));

describe("applyProbe: version handshake", () => {
  it("never judges a local gateway — versionSkew stays undefined", () => {
    expect(
      run([ok(T0, { version: "9.9.9", schemaEpoch: 99 })]).versionSkew
    ).toBeUndefined();
  });

  it("records a matching remote gateway as not skewed", () => {
    expect(
      run(
        [
          ok(T0, {
            version: EXPECTED_GATEWAY_VERSION,
            schemaEpoch: EXPECTED_SCHEMA_EPOCH,
          }),
        ],
        REMOTE_GW
      ).versionSkew
    ).toStrictEqual({
      skewed: false,
      gatewayVersion: EXPECTED_GATEWAY_VERSION,
      gatewaySchemaEpoch: EXPECTED_SCHEMA_EPOCH,
      gatewayProtocolVersion: EXPECTED_SCHEMA_EPOCH,
      clientVersion: EXPECTED_GATEWAY_VERSION,
      clientSchemaEpoch: EXPECTED_SCHEMA_EPOCH,
      clientProtocolVersion: EXPECTED_SCHEMA_EPOCH,
    });
  });

  it("treats only protocol skew as unsafe and retains that verdict through outages", () => {
    const productOnly = run(
      [ok(T0, { version: "9.9.9", schemaEpoch: EXPECTED_SCHEMA_EPOCH })],
      REMOTE_GW
    );
    expect(productOnly.versionSkew).toMatchObject({
      skewed: false,
      gatewayVersion: "9.9.9",
    });

    const skewed = run(
      [
        ok(T0, {
          version: EXPECTED_GATEWAY_VERSION,
          schemaEpoch: EXPECTED_SCHEMA_EPOCH + 1,
        }),
      ],
      REMOTE_GW
    );
    expect(applyProbe(skewed, fail(T0 + 5000)).versionSkew).toMatchObject({
      skewed: true,
      gatewaySchemaEpoch: EXPECTED_SCHEMA_EPOCH + 1,
    });
    expect(
      applyProbe(
        skewed,
        ok(T0 + 10_000, { version: undefined, schemaEpoch: undefined })
      ).versionSkew
    ).toMatchObject({
      skewed: true,
      gatewaySchemaEpoch: EXPECTED_SCHEMA_EPOCH + 1,
    });
  });
});

describe(applyVersionSkewAlert, () => {
  const config = { enabled: true, thresholdSeconds: DEFAULT_ALERT_SECONDS };
  const skewed = () =>
    run(
      [
        ok(T0, {
          version: EXPECTED_GATEWAY_VERSION,
          schemaEpoch: EXPECTED_SCHEMA_EPOCH + 1,
        }),
      ],
      REMOTE_GW
    );

  it("fires immediately for a protocol-skewed remote and de-dupes its episode", () => {
    let state = skewed();
    expect(applyVersionSkewAlert(state, config, T0).action).toStrictEqual({
      gatewayVersion: EXPECTED_GATEWAY_VERSION,
      gatewaySchemaEpoch: EXPECTED_SCHEMA_EPOCH + 1,
    });
    ({ state } = applyVersionSkewAlert(state, config, T0));
    expect(state.versionSkewAlertedAt).toBe(T0);
    expect(
      applyVersionSkewAlert(state, config, T0 + 60_000).action
    ).toBeUndefined();
  });

  it("does not alert when disabled, matching, or local", () => {
    expect(
      applyVersionSkewAlert(skewed(), { ...config, enabled: false }, T0).action
    ).toBeUndefined();
    expect(
      applyVersionSkewAlert(
        run(
          [
            ok(T0, {
              version: EXPECTED_GATEWAY_VERSION,
              schemaEpoch: EXPECTED_SCHEMA_EPOCH,
            }),
          ],
          REMOTE_GW
        ),
        config,
        T0
      ).action
    ).toBeUndefined();
    expect(
      applyVersionSkewAlert(
        run([ok(T0, { version: "9.9.9", schemaEpoch: 99 })]),
        config,
        T0
      ).action
    ).toBeUndefined();
  });

  it("re-arms after a matching probe and fires again when the protocol diverges", () => {
    let state = skewed();
    ({ state } = applyVersionSkewAlert(state, config, T0));
    state = applyProbe(
      state,
      ok(T0 + 10_000, {
        version: EXPECTED_GATEWAY_VERSION,
        schemaEpoch: EXPECTED_SCHEMA_EPOCH,
      })
    );
    ({ state } = applyVersionSkewAlert(state, config, T0 + 10_000));
    expect(state.versionSkewAlertedAt).toBeUndefined();
    state = applyProbe(
      state,
      ok(T0 + 20_000, {
        version: EXPECTED_GATEWAY_VERSION,
        schemaEpoch: EXPECTED_SCHEMA_EPOCH + 1,
      })
    );
    expect(
      applyVersionSkewAlert(state, config, T0 + 20_000).action
    ).toStrictEqual({
      gatewayVersion: EXPECTED_GATEWAY_VERSION,
      gatewaySchemaEpoch: EXPECTED_SCHEMA_EPOCH + 1,
    });
  });
});
