import crypto from "node:crypto";
import { promises as fs } from "node:fs";
/*
 * The experimental gate over a REAL boot (v0 early feedback). The unit suite
 * beside this one pins the resolver's precedence; this one pins what a client
 * actually observes: with the gate off the automations and connectors
 * surfaces are absent from the C1 handshake AND unroutable, and with the gate
 * on the same URLs answer. A durable `gateway.experimental.*` pref written
 * through the prefs API boots the surface enabled on the next serve, which is
 * how the shell's toggle works — the gate is read once per boot.
 */
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { ROUTES } from "@centraid/core/protocol";
import type { GatewayInfo } from "@centraid/core/protocol";
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import {
  EXPERIMENTAL_FEATURE_PREF_KEYS,
  EXPERIMENTAL_FEATURES,
} from "./experimental-features.ts";
import type {
  ExperimentalFeature,
  ExperimentalFeatureSet,
} from "./experimental-features.ts";
import { serve } from "./serve.ts";
import type { GatewayServeHandle, ServeOptions } from "./serve.ts";

/**
 * The URLs each feature's gate owns — reachable only while that feature is on.
 *
 * `Record<ExperimentalFeature, …>` is exhaustive by type: a feature added to
 * the registry does not compile here until it says what it mounts, so a new
 * gate cannot ship advertising a capability whose surface nothing checks.
 */
const GATED_SURFACES: Record<ExperimentalFeature, readonly string[]> = {
  automations: [
    "/centraid/_automations",
    "/centraid/_insights/summary?windowDays=30",
  ],
  connectors: [ROUTES.vaultConnections, ROUTES.vaultOAuthCallback],
};

/** Exactly one feature on. Full (not `Partial`) so a third feature breaks the
 *  build here rather than being quietly left off. */
function onlyGateOpen(open: ExperimentalFeature): ExperimentalFeatureSet {
  return {
    automations: open === "automations",
    connectors: open === "connectors",
  };
}

let dataDir: string;
let handle: GatewayServeHandle | undefined;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}

async function boot(
  extra: Omit<ServeOptions, "paths"> = {}
): Promise<GatewayServeHandle> {
  handle = await serve({ paths: pathsUnder(dataDir), ...extra });
  return handle;
}

function auth(): Record<string, string> {
  if (!handle) throw new Error("no gateway booted");
  return { Authorization: `Bearer ${handle.token}` };
}

async function capabilities(): Promise<Record<string, unknown>> {
  const res = await fetch(`${handle?.url}${ROUTES.gatewayInfo}`, {
    headers: auth(),
  });
  expect(res.status).toBe(200);
  const payload = (await res.json()) as GatewayInfo;
  return payload.capabilities as unknown as Record<string, unknown>;
}

async function status(pathname: string): Promise<number> {
  const res = await fetch(`${handle?.url}${pathname}`, { headers: auth() });
  return res.status;
}

/** What a client can see about the gates from one boot. */
interface GateObservation {
  gateOpen: ExperimentalFeature;
  advertises: Record<string, unknown>;
  mounts: Record<string, boolean>;
}

/** Boot with exactly one gate open, and record both halves of what that gate
 *  is supposed to control: the handshake, and which surfaces are owned. */
async function observeGate(
  open: ExperimentalFeature
): Promise<GateObservation> {
  const gate = await boot({ experimental: onlyGateOpen(open) });
  const caps = await capabilities();
  const probes = EXPERIMENTAL_FEATURES.flatMap(
    (feature) => GATED_SURFACES[feature]
  );
  const codes = await Promise.all(probes.map((surface) => status(surface)));
  await gate.close();
  handle = undefined;
  return {
    advertises: Object.fromEntries(
      EXPERIMENTAL_FEATURES.map((feature) => [feature, caps[feature]] as const)
    ),
    gateOpen: open,
    // 404 is the mounted-ness signal: an unmounted family is owned by nothing,
    // while a mounted route answers on its own terms — 200, or a refusal it
    // authored itself.
    mounts: Object.fromEntries(
      probes.map((surface, index) => [surface, codes[index] !== 404] as const)
    ),
  };
}

/** The same shape, as the gate contract says it must be. */
function expectedWith(open: ExperimentalFeature): GateObservation {
  return {
    advertises: Object.fromEntries(
      EXPERIMENTAL_FEATURES.map((feature) => [feature, feature === open])
    ),
    gateOpen: open,
    mounts: Object.fromEntries(
      EXPERIMENTAL_FEATURES.flatMap((feature) =>
        GATED_SURFACES[feature].map(
          (surface) => [surface, feature === open] as const
        )
      )
    ),
  };
}

describe("experimental-gating scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`experimental-gating-${crypto.randomUUID()}-`);
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  /*
   * The law the scenarios below each prove one half of: the handshake and the
   * router must agree, per feature, in both directions. A capability
   * advertised over a surface that was deleted is the shape of the #765
   * regression — the client mounts a place whose routes 404 — and a surface
   * mounted under no capability is a feature shipping in the dark.
   *
   * Enumerated over the registry rather than the two names we happen to have,
   * so a third experiment inherits the law instead of needing a new test.
   */
  test("[law:experimental-gate-parity] a feature is advertised exactly when its own surface is mounted", async () => {
    // One boot per feature, keyed by a full `Record<ExperimentalFeature, …>`
    // so a third experiment does not compile until it is observed here too.
    const observed: Record<ExperimentalFeature, GateObservation> = {
      automations: await observeGate("automations"),
      connectors: await observeGate("connectors"),
    };
    for (const open of EXPERIMENTAL_FEATURES) {
      expect(observed[open]).toStrictEqual(expectedWith(open));
    }
  });

  test("a default gateway advertises neither experiment", async () => {
    await boot();
    await expect(capabilities()).resolves.toMatchObject({
      automations: false,
      connectors: false,
      automationTurns: false,
    });
  });

  test("opting in advertises both experiments", async () => {
    await boot({ experimental: { automations: true, connectors: true } });
    await expect(capabilities()).resolves.toMatchObject({
      automations: true,
      connectors: true,
      automationTurns: true,
    });
  });

  test("the automations and insights families are unroutable while gated off", async () => {
    await boot();
    await expect(status("/centraid/_automations")).resolves.toBe(404);
    await expect(
      status("/centraid/_insights/summary?windowDays=30")
    ).resolves.toBe(404);
    // The apps family shares the same registration and must stay reachable.
    await expect(status("/centraid/_apps/_sessions")).resolves.not.toBe(404);
  });

  test("the automations and insights families answer once opted in", async () => {
    await boot({ experimental: { automations: true } });
    await expect(status("/centraid/_automations")).resolves.toBe(200);
    await expect(
      status("/centraid/_insights/summary?windowDays=30")
    ).resolves.toBe(200);
  });

  test("the connections route and OAuth callback are unroutable while gated off", async () => {
    await boot();
    await expect(status(ROUTES.vaultConnections)).resolves.toBe(404);
    await expect(status(ROUTES.vaultOAuthCallback)).resolves.toBe(404);
  });

  test("the connections route and OAuth callback answer once opted in", async () => {
    await boot({ experimental: { connectors: true } });
    await expect(status(ROUTES.vaultConnections)).resolves.toBe(200);
    // No `state` capability on the query: the route owns the request and
    // refuses it, which is what proves it is mounted at all.
    await expect(status(ROUTES.vaultOAuthCallback)).resolves.not.toBe(404);
  });

  test("webhook ingress is not owned at all while automations are gated off", async () => {
    await boot();
    const res = await fetch(`${handle?.url}/_centraid-hook/some-slug`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    // The ingress handler's own 404 carries this body; the host chain's does
    // not. Off means the trigger route never sees the request.
    await expect(res.json()).resolves.not.toMatchObject({
      error: "unknown webhook",
    });
  });

  test("webhook ingress owns its route once opted in", async () => {
    await boot({ experimental: { automations: true } });
    const res = await fetch(`${handle?.url}/_centraid-hook/some-slug`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: "unknown webhook",
    });
  });

  test("a durable gateway.experimental.automations pref boots the surface enabled", async () => {
    const first = await boot();
    await expect(status("/centraid/_automations")).resolves.toBe(404);
    first.prefs.setPrefs({
      [EXPERIMENTAL_FEATURE_PREF_KEYS.automations]: true,
    });
    await first.close();
    handle = undefined;

    // Same data dir, no host option: the pref alone opens the surface.
    await boot();
    await expect(capabilities()).resolves.toMatchObject({ automations: true });
    await expect(status("/centraid/_automations")).resolves.toBe(200);
  });
});
