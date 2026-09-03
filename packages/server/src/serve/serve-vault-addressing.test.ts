import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import type { WorktreeStore } from "../worktree-store/index.js";
import { serve } from "./serve.ts";
import type { GatewayServeHandle } from "./serve.ts";
import { runWithVaultContext } from "./vault-context.ts";

let dataDir: string;
let handle: GatewayServeHandle;
let vaultA: string;
let vaultB: string;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}

async function seedApp(store: WorktreeStore, appId: string): Promise<void> {
  const session = await store.openSession(`seed-${appId}`);
  const appDir = path.join(session.worktreePath, "apps", appId);
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(
    path.join(appDir, "app.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: appId,
      name: appId,
      version: "0.1.0",
    })
  );
  await store.publish({ sessionId: `seed-${appId}`, appId, message: "seed" });
  await store.closeSession(`seed-${appId}`);
}

const DEVICE_HEADER = "x-test-device";

describe("serve-vault-addressing scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`addr-gateway-${crypto.randomUUID()}-`);
    handle = await serve({
      paths: pathsUnder(dataDir),
      deviceAccess: {
        deviceKeyFor: (req) => {
          const v = req.headers[DEVICE_HEADER];
          return typeof v === "string" ? v : undefined;
        },
        vaultsFor: (deviceKey) =>
          deviceKey === "family-phone"
            ? [vaultB]
            : deviceKey === "owner-laptop"
              ? [vaultA, vaultB]
              : [],
      },
    });
    vaultA = handle.vaults.defaultVaultId();
    vaultB = handle.vaults.create("Family").vaultId;

    await seedApp(await handle.appsStore(), "app-a");
    await handle.syncApps(vaultA);
    await runWithVaultContext({ vaultId: vaultB }, async () => {
      await seedApp(await handle.appsStore(), "app-b");
    });
    await handle.syncApps(vaultB);
  }, 30_000);

  afterEach(async () => {
    await handle.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  function get(
    pathname: string,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    return fetch(`${handle.url}${pathname}`, {
      headers: {
        Authorization: `Bearer ${handle.token}`,
        [DEVICE_HEADER]: "owner-laptop",
        ...headers,
      },
    });
  }

  test("two clients address two vaults concurrently — disjoint app worlds, no switch", async () => {
    const [aRes, bRes] = await Promise.all([
      get("/centraid/_apps", { "x-centraid-vault": vaultA }),
      get("/centraid/_apps", { "x-centraid-vault": vaultB }),
    ]);
    const aApps = (await aRes.json()) as Array<{ id: string }>;
    const bApps = (await bRes.json()) as Array<{ id: string }>;
    expect(aApps.map((a) => a.id)).toContain("app-a");
    expect(aApps.map((a) => a.id)).not.toContain("app-b");
    expect(bApps.map((a) => a.id)).toContain("app-b");
    expect(bApps.map((a) => a.id)).not.toContain("app-a");

    const described = await get("/centraid/app-b/_describe", {
      "x-centraid-vault": vaultB,
    });
    expect(described.status).toBe(200);
    await expect(described.json()).resolves.toMatchObject({
      manifest: { id: "app-b" },
    });

    const defaulted = (await (await get("/centraid/_vault/status")).json()) as {
      vaultId: string;
    };
    expect(defaulted.vaultId).toBe(vaultA);
  });

  test("an un-enrolled vault header fails closed, never falls back", async () => {
    const res = await get("/centraid/_apps", { "x-centraid-vault": "nope" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "vault_not_enrolled",
    });
  });

  test("a device is confined to its enrollments (issue #289 phase 2)", async () => {
    const implied = (await (
      await get("/centraid/_vault/status", { [DEVICE_HEADER]: "family-phone" })
    ).json()) as { vaultId: string };
    expect(implied.vaultId).toBe(vaultB);

    const denied = await get("/centraid/_vault/status", {
      [DEVICE_HEADER]: "family-phone",
      "x-centraid-vault": vaultA,
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: "vault_not_enrolled",
    });

    const stranger = await get("/centraid/_apps", {
      [DEVICE_HEADER]: "stolen-laptop",
    });
    expect(stranger.status).toBe(403);
    await expect(stranger.json()).resolves.toMatchObject({
      error: "device_not_enrolled",
    });

    const listed = (await (
      await get("/centraid/_vault/vaults", { [DEVICE_HEADER]: "family-phone" })
    ).json()) as { vaults: Array<{ vaultId: string }> };
    expect(listed.vaults.map((v) => v.vaultId)).toStrictEqual([vaultB]);

    const all = (await (
      await get("/centraid/_vault/vaults", { [DEVICE_HEADER]: "owner-laptop" })
    ).json()) as { vaults: Array<{ vaultId: string }> };
    expect(all.vaults.map((v) => v.vaultId).sort()).toStrictEqual(
      [vaultA, vaultB].sort()
    );
  });
});
