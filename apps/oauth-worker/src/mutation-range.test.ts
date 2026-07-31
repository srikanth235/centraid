/**
 * Guard for the line-addressed Stryker mutation range (#656 Layer 3).
 *
 * `stryker.config.mjs` seeds `src/worker.ts:<start>-<end>` — the pure
 * predicate block — because most of `worker.ts` is I/O and does not belong in
 * a mutation seed. Line addressing is only safe if something fails when the
 * lines move. This is that something.
 *
 * It lives OUTSIDE `vitest.mutation.config.ts` on purpose: Stryker's sandbox
 * holds an instrumented re-print of `worker.ts` with different line numbers,
 * so this assertion is only meaningful against the real working tree. The
 * package's normal `bun run test` picks it up, which is where drift must fail.
 */
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
    // The block opens on `validEnvironment` and closes on `bounded`'s brace.
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
    // …and nothing impure crept into the range.
    expect(block).not.toMatch(/await |fetch\(|crypto\.|Response\(/u);
  });
});
