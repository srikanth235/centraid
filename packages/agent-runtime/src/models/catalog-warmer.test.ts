import path from "node:path";

import { describe, expect, test } from "vitest";

import type { HarnessModel } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { CatalogWarmer, deriveStatus } from "./catalog-warmer.ts";
import { readCatalog } from "./catalog.ts";

let counter = 0;
async function tmpCatalogPath(): Promise<string> {
  const dir = await tempDir("centraid-warmer-");
  return path.join(dir, `model-catalog-${counter++}.json`);
}

const noModels = async (): Promise<HarnessModel[]> => [];

describe("catalog-warmer", () => {
  test("warm writes a non-empty model enumeration to the catalog", async () => {
    const catalogPath = await tmpCatalogPath();
    const warmer = new CatalogWarmer({
      catalogPath,
      enumerateModels: async () => [{ id: "sonnet" }, { id: "haiku" }],
    });
    await warmer.warm("claude-code", "models");
    const entry = (await readCatalog(catalogPath))?.harnesses["claude-code"];
    expect(entry?.models?.map((m) => m.id)).toStrictEqual(["sonnet", "haiku"]);
    expect(entry?.hash).toBeTruthy();
    expect(entry?.enumeratedAt).toBeTruthy();
  });

  test("concurrent warms for the same surface dedupe to one enumeration", async () => {
    const catalogPath = await tmpCatalogPath();
    let calls = 0;
    // Event-driven gate instead of a fixed sleep: the enumeration stays
    // in flight until the test has asserted the warming window, then the
    // test releases it — no wall clock involved.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const warmer = new CatalogWarmer({
      catalogPath,
      enumerateModels: async () => {
        calls += 1;
        await gate;
        return [{ id: "sonnet" }];
      },
    });
    const a = warmer.warm("claude-code", "models");
    expect(warmer.isWarming("claude-code", "models")).toBe(true);
    const b = warmer.warm("claude-code", "models");
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(warmer.isWarming("claude-code", "models")).toBe(false);
  });

  test("an empty enumeration writes nothing and never clobbers a prior entry", async () => {
    const catalogPath = await tmpCatalogPath();
    const good = new CatalogWarmer({
      catalogPath,
      enumerateModels: async () => [{ id: "sonnet" }],
    });
    await good.warm("claude-code", "models");
    const bad = new CatalogWarmer({
      catalogPath,
      enumerateModels: noModels, // transient failure → []
    });
    await bad.warm("claude-code", "models");
    expect(
      (await readCatalog(catalogPath))?.harnesses["claude-code"]?.models?.map(
        (m) => m.id
      )
    ).toStrictEqual(["sonnet"]);
  });

  test("a throwing enumerator is swallowed and writes nothing", async () => {
    const catalogPath = await tmpCatalogPath();
    const warmer = new CatalogWarmer({
      catalogPath,
      enumerateModels: async () => {
        throw new Error("boom");
      },
    });
    await warmer.warm("claude-code", "models"); // must not reject
    await expect(readCatalog(catalogPath)).resolves.toBeUndefined();
  });

  // A harness that self-reports no models (opencode, grok) leaves the cache
  // empty forever. The read path only re-kicks a warm while the question is
  // unanswered — otherwise every poll restarted a warm, `isWarming` was true
  // at read time, and the surface reported `loading` for good.
  test("records a completed warm even when it enumerated nothing", async () => {
    const catalogPath = await tmpCatalogPath();
    const warmer = new CatalogWarmer({
      catalogPath,
      enumerateModels: noModels,
    });
    expect(warmer.hasWarmed("opencode", "models")).toBe(false);
    await warmer.warm("opencode", "models");
    expect(warmer.hasWarmed("opencode", "models")).toBe(true);
    expect(warmer.isWarming("opencode", "models")).toBe(false);
    // The surface can now settle instead of spinning.
    expect(deriveStatus(0, warmer.isWarming("opencode", "models"))).toBe(
      "empty"
    );
    // A different kind is still unasked.
    expect(warmer.hasWarmed("codex", "models")).toBe(false);
  });

  test("records a completed warm even when the enumerator threw", async () => {
    const catalogPath = await tmpCatalogPath();
    const warmer = new CatalogWarmer({
      catalogPath,
      enumerateModels: async () => {
        throw new Error("boom");
      },
    });
    await warmer.warm("grok", "models");
    expect(warmer.hasWarmed("grok", "models")).toBe(true);
  });

  test("deriveStatus: loading wins over a cache, then ready, else empty", () => {
    expect(deriveStatus(0, false)).toBe("empty");
    expect(deriveStatus(0, true)).toBe("loading");
    expect(deriveStatus(3, false)).toBe("ready");
    // A refresh over an existing list is still loading so the client polls.
    expect(deriveStatus(3, true)).toBe("loading");
  });
});
