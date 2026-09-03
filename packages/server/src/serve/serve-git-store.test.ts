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
  await fs.mkdir(path.join(appDir, "queries"), { recursive: true });
  await fs.writeFile(
    path.join(appDir, "app.json"),
    JSON.stringify(
      {
        manifestVersion: 1,
        id: appId,
        name: "Git Store App",
        version: "0.1.0",
        tables: [],
        actions: [],
        queries: [
          {
            name: "ping",
            description: "returns pong",
            input: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(appDir, "queries", "ping.js"),
    "export default async () => ({ pong: true });\n"
  );
  await store.publish({ sessionId: "seed", appId, message: "seed" });
  await store.closeSession("seed");
}

describe("serve-git-store scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gateway-git-store-${crypto.randomUUID()}-`);
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("runs an app from the git-store main worktree, not versions/", async () => {
    handle = await serve({ paths: pathsUnder(dataDir) });

    const store = await handle.appsStore();
    await seedApp(store, "gitapp");
    await handle.syncApps();

    const list = await fetch(`${handle.url}/centraid/_apps`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(list.status).toBe(200);
    const apps = (await list.json()) as Array<{ id: string }>;
    expect(apps.some((a) => a.id === "gitapp")).toBeTruthy();

    const read = await fetch(`${handle.url}/centraid/gitapp/queries/ping`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: {} }),
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toStrictEqual({ pong: true });
  });

  test("the code store lives inside the active vault directory (#280)", async () => {
    handle = await serve({ paths: pathsUnder(dataDir) });
    const store = await handle.appsStore();
    const vaultId = handle.vaults.current().boot.vaultId;
    expect(
      store
        .getActiveMainLink()
        .startsWith(path.join(dataDir, "vault", vaultId, "code"))
    ).toBeTruthy();
  });
});
