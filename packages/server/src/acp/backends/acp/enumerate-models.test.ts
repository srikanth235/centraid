import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { enumerateAcpModels, mapOfferedModels } from "./enumerate-models.js";
import type { AcpTurnConfig } from "./types.js";

const FAKE_HARNESS = fileURLToPath(
  new URL("fake-acp-harness.mjs", import.meta.url)
);

function fakeConfig(
  extraArgs: string[],
  over: Partial<AcpTurnConfig> = {}
): AcpTurnConfig {
  return {
    kind: "acp",
    acpArgs: [],
    binPath: FAKE_HARNESS,
    extraArgs,
    ...over,
  };
}

describe("enumerate-models", () => {
  test("maps the harness’s advertised model options to HarnessModel[]", async () => {
    const models = await enumerateAcpModels(fakeConfig(["--mode=normal"]));
    expect(models).toStrictEqual([
      { id: "fake-model-default", name: "Default", default: true },
      { id: "fake-opus-9-1", name: "Most capable" },
    ]);
  });

  test("a harness with no model option enumerates []", async () => {
    const models = await enumerateAcpModels(
      fakeConfig(["--mode=normal", "--no-model-option"])
    );
    expect(models).toStrictEqual([]);
  });

  test("AUTH_REQUIRED (-32000) from session/new enumerates [] rather than throwing", async () => {
    const models = await enumerateAcpModels(fakeConfig(["--mode=auth"]));
    expect(models).toStrictEqual([]);
  });

  test("a missing binary enumerates [] rather than throwing", async () => {
    const dir = await tempDir("acp-enum-missing-");
    const models = await enumerateAcpModels(
      fakeConfig(["--mode=normal"], {
        binPath: path.join(dir, "does-not-exist"),
      })
    );
    expect(models).toStrictEqual([]);
  });

  test("the child process is dead once enumeration resolves", async () => {
    const dir = await tempDir("acp-enum-pid-");
    const pidMarker = path.join(dir, "pid");
    const models = await enumerateAcpModels(
      fakeConfig(["--mode=normal", `--pid-marker=${pidMarker}`])
    );
    expect(models.length).toBeGreaterThan(0);

    const pid = Number((await fs.readFile(pidMarker, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
  });

  test("mapOfferedModels dedupes by id, drops blanks, and flags the current value", () => {
    const models = mapOfferedModels(
      [
        { value: " a ", name: "Alpha" },
        { value: "a", name: "Alpha dup" }, // deduped
        { value: "", name: "blank" }, // dropped
        { value: "b", name: "b" }, // name === id → name dropped
      ],
      "a"
    );
    expect(models).toStrictEqual([
      { id: "a", name: "Alpha", default: true },
      { id: "b" },
    ]);
  });
});
