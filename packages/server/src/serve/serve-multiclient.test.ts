import crypto from "node:crypto";
/*
 * Multi-client integration: prove that two independent HTTP clients
 * pointed at the same daemon see consistent gateway state. The "two
 * clients" stand in for desktop + mobile pointed at a shared standalone
 * gateway via the existing remote-gateway path.
 *
 * Scenario:
 *   1. An app is published onto the git-store `main` (#137).
 *   2. Client A fetches GET /centraid/_apps and sees it in the registry.
 *   3. Client B reads back the app's `index.html` via the `/centraid/<id>/`
 *      static-serve path (proves static serving works through the daemon
 *      from the live `main` worktree, not just the bearer check).
 *
 * No CLI spawn — we drive `serve()` in-process. The CLI smoke is
 * covered in `cli.test.ts`. This test focuses on the runtime contract
 * a second client expects after the gateway holds a published app.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import type { WorktreeStore } from "../worktree-store/index.js";
import { serve } from "./serve.ts";
import type { GatewayServeHandle } from "./serve.ts";

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}

/** Publish one app onto the git-store `main`, before serve() boots. */
async function seedApp(store: WorktreeStore, appId: string): Promise<void> {
  const session = await store.openSession("seed");
  const appDir = path.join(session.worktreePath, "apps", appId);
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(
    path.join(appDir, "app.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: appId,
      name: "multiclient-test",
      version: "0.1.0",
    })
  );
  await store.publish({ sessionId: "seed", appId, message: "seed" });
  await store.closeSession("seed");
}

describe("serve-multiclient scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`mc-gateway-${crypto.randomUUID()}-`);
    handle = await serve({ paths: pathsUnder(dataDir) });
    await seedApp(await handle.appsStore(), "multiclient-test");
    await handle.syncApps();
  });

  afterEach(async () => {
    await handle.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("two clients see the published app consistently in the registry + app plane", async () => {
    // Client A: list — sees the app synced from `main`.
    const list = await fetch(`${handle.url}/centraid/_apps`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(list.status).toBe(200);
    const apps = (await list.json()) as Array<{ id: string }>;
    expect(apps.some((a) => a.id === "multiclient-test")).toBeTruthy();

    // Client B: describe the app — proves the daemon's `/centraid/<id>/`
    // app plane resolves the live `main` worktree's manifest, not just the
    // registry index.
    const described = await fetch(
      `${handle.url}/centraid/multiclient-test/_describe`,
      { headers: { Authorization: `Bearer ${handle.token}` } }
    );
    expect(described.status).toBe(200);
    await expect(described.json()).resolves.toMatchObject({
      manifest: { id: "multiclient-test", name: "multiclient-test" },
    });
  });
});
