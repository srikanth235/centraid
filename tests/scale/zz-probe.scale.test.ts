import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { serve } from "../../packages/server/src/serve/serve.js";

describe("probe", () => {
  test("probe routes", async () => {
    const dataDir = await tempDir("probe-");
    const handle = await serve({
      paths: { vaultDir: path.join(dataDir, "vault") },
      token: "probe-token",
    });
    const auth = { Authorization: "Bearer probe-token" };
    const paths = [
      "/centraid/_vault/changes?since=0:0&limit=50",
      "/centraid/_vault/replica/bootstrap?window=100",
      "/centraid/_vault/automations",
      "/centraid/_vault/apps",
      "/centraid/notes/_describe",
      "/centraid/tasks/_describe",
      "/centraid/_vault/atlas/browse/rows?table=core.party&limit=10",
    ];
    for (const p of paths) {
      const res = await fetch(`${handle.url}${p}`, { headers: auth });
      const body = await res.text();
      console.log("GET", p, res.status, body.slice(0, 400));
    }
    for (const [p, body] of [
      ["/centraid/notes/queries/list", "{}"],
      ["/centraid/tasks/queries/list", "{}"],
    ] as const) {
      const res = await fetch(`${handle.url}${p}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body,
      });
      console.log("POST", p, res.status, (await res.text()).slice(0, 300));
    }
    await handle.close();
    expect(true).toBe(true);
  }, 120_000);
});
