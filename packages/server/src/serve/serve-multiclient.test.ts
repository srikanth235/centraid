import crypto from "node:crypto";
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
    const list = await fetch(`${handle.url}/centraid/_apps`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(list.status).toBe(200);
    const apps = (await list.json()) as Array<{ id: string }>;
    expect(apps.some((a) => a.id === "multiclient-test")).toBeTruthy();

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
