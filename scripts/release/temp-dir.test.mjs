import { accessSync } from "node:fs";
import { access } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { tempDir, tempDirSync } from "./temp-dir.mjs";

describe("temp-dir", () => {
  test("tempDir creates an accessible tracked directory", async () => {
    const dir = await tempDir("centraid-release-");
    await expect(access(dir)).resolves.toBeUndefined();
  });

  test("tempDirSync supports synchronous hooks and constructors", () => {
    expect(() =>
      accessSync(tempDirSync("centraid-release-sync-"))
    ).not.toThrow();
  });
});
