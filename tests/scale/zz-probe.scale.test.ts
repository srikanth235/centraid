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
      "/centraid/_gateway/info",
      "/centraid/_gateway/health",
      "/centraid/_apps",
      "/centraid/_vault/status",
      "/centraid/_vault/changes?since=0&limit=50",
      "/centraid/_vault/atlas/browse?sub=tables",
      "/centraid/_vault/atlas/browse/tables",
      "/centraid/_vault/atlas/browse/rows?table=core_party&limit=10",
      "/centraid/_vault/atlas/browse/ref-search?table=core.party&query=a",
      "/centraid/_vault/atlas/census",
    ];
    for (const p of paths) {
      const res = await fetch(`${handle.url}${p}`, { headers: auth });
      const body = await res.text();
      console.log(p, res.status, body.slice(0, 200));
    }
    // blob stage
    const up = await fetch(
      `${handle.url}/centraid/_vault/blobs?filename=a.bin&media_type=application/octet-stream`,
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/octet-stream" },
        body: Buffer.alloc(1024, 7),
      }
    );
    console.log("blob POST", up.status, (await up.text()).slice(0, 300));
    await handle.close();
    expect(true).toBe(true);
  }, 120_000);
});
