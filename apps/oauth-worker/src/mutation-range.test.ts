import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

describe("mutation range", () => {
  test("the seeded Stryker line range still brackets the pure guard block", () => {
    const config = readFileSync(
      new URL("../stryker.config.mjs", import.meta.url),
      "utf8"
    );
    const spec = /"src\/worker\.ts:(?<start>\d+)-(?<end>\d+)"/u.exec(config);
    expect(
      spec,
      "no worker.ts mutation range in stryker.config.mjs"
    ).not.toBeNull();
    const start = Number(spec?.groups?.start);
    const end = Number(spec?.groups?.end);

    const lines = readFileSync(
      new URL("worker.ts", import.meta.url),
      "utf8"
    ).split("\n");
    expect(lines[start - 1]).toContain("function validEnvironment(");
    expect(lines[end - 1]).toBe("}");
    const block = lines.slice(start - 1, end).join("\n");
    for (const fn of [
      "validEnvironment",
      "isLoopbackUrl",
      "isLoopbackOrigin",
      "safeOAuthError",
      "validatedScopes",
      "sameScopes",
      "bounded",
    ]) {
      expect(block, fn).toContain(`function ${fn}(`);
    }
    expect(block).not.toMatch(/await |fetch\(|crypto\.|Response\(/u);
  });
});
