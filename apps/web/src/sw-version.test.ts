import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SERVICE_WORKER_VERSION } from "./sw-version.js";

const root = path.resolve(import.meta.dirname, "..");

describe("SERVICE_WORKER_VERSION (K8 single source)", () => {
  it("is the only hand-authored version token; public/sw.js mirrors it", () => {
    expect(SERVICE_WORKER_VERSION).toMatch(/^v\d+$/u);
    const sw = readFileSync(path.join(root, "public/sw.js"), "utf8");
    const m = sw.match(/const VERSION = ['"](?<version>[^'"]+)['"]/u);
    expect(m?.[1]).toBe(SERVICE_WORKER_VERSION);
    const stamp = readFileSync(
      path.join(root, "scripts/stamp-sw-version.mjs"),
      "utf8"
    );
    expect(stamp).toContain("sw-version.ts");
    expect(stamp).toContain("public/sw.js");
    const workerBuild = readFileSync(
      path.join(root, "scripts/build-iroh-worker.mjs"),
      "utf8"
    );
    expect(workerBuild).toContain("centraid-worker-iroh.wasm");
    expect(sw).toContain(
      ["importScripts(`/centraid-worker-iroh.js?v=$", "{VERSION}`)"].join("")
    );
  });
});
