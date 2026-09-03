import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.ts";
import { serve } from "../serve/serve.ts";
import type { GatewayServeHandle } from "../serve/serve.ts";
import type { WorktreeStore } from "../worktree-store/index.js";

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, "vault"),
  };
}

const MANIFEST = (appId: string): string =>
  JSON.stringify(
    {
      manifestVersion: 1,
      id: appId,
      name: "Draftable App",
      version: "0.1.0",
      tables: [],
      actions: [],
      queries: [
        {
          name: "ping",
          description: "returns a marker",
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
  );

async function seedApp(store: WorktreeStore, appId: string): Promise<void> {
  const session = await store.openSession("seed");
  const appDir = path.join(session.worktreePath, "apps", appId);
  await fs.mkdir(path.join(appDir, "queries"), { recursive: true });
  await fs.writeFile(path.join(appDir, "app.json"), MANIFEST(appId));
  await fs.writeFile(
    path.join(appDir, "index.html"),
    "<!doctype html><head></head>PUBLISHED"
  );
  await fs.writeFile(
    path.join(appDir, "queries", "ping.js"),
    "export default async () => ({ marker: 'published' });\n"
  );
  await store.publish({ sessionId: "seed", appId, message: "seed" });
  await store.closeSession("seed");
}

describe("draft-preview-over-http scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`gateway-draft-${crypto.randomUUID()}-`);
  });

  afterEach(async () => {
    await handle?.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("runs a staged draft handler while live keeps the published one", async () => {
    handle = await serve({ paths: pathsUnder(dataDir) });
    const store = await handle.appsStore();
    await seedApp(store, "app");
    await handle.syncApps();

    await store.openSession("draft1");
    const draftDir = await store.snapshotSessionAppDir("draft1", "app");
    await fs.writeFile(
      path.join(draftDir, "queries", "ping.js"),
      "export default async () => ({ marker: 'draft' });\n"
    );

    const auth = { Authorization: `Bearer ${handle.token}` };

    const liveRead = await fetch(`${handle.url}/centraid/app/queries/ping`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    await expect(liveRead.json()).resolves.toStrictEqual({
      marker: "published",
    });

    const draftRead = await fetch(
      `${handle.url}/centraid/_draft/draft1/app/queries/ping`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ input: {} }),
      }
    );
    expect(draftRead.status).toBe(200);
    await expect(draftRead.json()).resolves.toStrictEqual({ marker: "draft" });
  });

  test("an unknown draft session runs the app's published handler", async () => {
    handle = await serve({ paths: pathsUnder(dataDir) });
    await seedApp(await handle.appsStore(), "app");
    await handle.syncApps();

    const res = await fetch(
      `${handle.url}/centraid/_draft/ghost/app/queries/ping`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: {} }),
      }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual({ marker: "published" });
  });

  test("the retired UI-byte draft surface is not a route", async () => {
    handle = await serve({ paths: pathsUnder(dataDir) });
    const store = await handle.appsStore();
    await seedApp(store, "app");
    await handle.syncApps();
    await store.openSession("draft1");

    const auth = { Authorization: `Bearer ${handle.token}` };
    const retired = [
      "/centraid/app/",
      "/centraid/app/index.html",
      "/centraid/_draft/draft1/app/",
      "/centraid/_draft/draft1/app/index.html",
    ];
    const statuses = await Promise.all(
      retired.map(async (url) => ({
        url,
        status: (await fetch(`${handle.url}${url}`, { headers: auth })).status,
      }))
    );
    expect(statuses).toStrictEqual(
      retired.map((url) => ({ url, status: 404 }))
    );
  });
});
