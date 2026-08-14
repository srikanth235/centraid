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

import { ROUTES } from "@centraid/protocol";
import type { GatewayInfo } from "@centraid/protocol";
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import { EXPERIMENTAL_FEATURE_PREF_KEYS } from "./experimental-features.ts";
import { serve } from "./serve.ts";
import type { GatewayServeHandle, ServeOptions } from "./serve.ts";

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

describe("experimental-gating scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`experimental-gating-${crypto.randomUUID()}-`);
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    await fs.rm(dataDir, { recursive: true, force: true });
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
