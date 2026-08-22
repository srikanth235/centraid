// @vitest-environment jsdom
//
// Harness regression pin (#842). This file exists for its DOCBLOCK, not for its
// coverage: it is the only mobile suite that asks a node project to transform
// one file through Vite's `client` environment while that file reaches
// `node:sqlite`. That combination is what silently killed
// `src/apps/tally/PendingRestartJourney.test.tsx` — Vite refused to bundle the
// builtin, the file died at transform, and a suite that collects zero tests
// looks like no suite at all rather than a red one.
//
// The externalization plugin now ships on both test-kit presets
// (`packages/test-kit/src/vitest.ts`); drop it from the node preset and this
// file stops collecting. Assert real driver behaviour so the pin is a working
// test rather than an import smoke check.
import { describe, expect, it } from "vitest";

import { NodeSqliteDriver } from "./node-sqlite-driver";

describe("node:sqlite driver under a jsdom docblock", () => {
  it("round-trips rows in a node project transformed through the client environment", () => {
    expect(document).toBeTypeOf("object");

    const driver = new NodeSqliteDriver();
    driver.exec("CREATE TABLE pin (id TEXT PRIMARY KEY, note TEXT)");
    driver.run("INSERT INTO pin (id, note) VALUES (?, ?)", [
      "restart",
      "collected",
    ]);

    // Field-by-field rather than a whole-object compare: `node:sqlite` returns
    // null-prototype rows, which no object matcher treats as a plain object.
    const rows = driver.all<{ id: string; note: string }>("SELECT * FROM pin");
    expect(rows).toHaveLength(1);
    // `toHaveLength` is a runtime check the type checker cannot see, and this
    // package runs with `noUncheckedIndexedAccess`. Read the row through `?.`
    // rather than `!`: a missing row then fails on the value assertion below,
    // which the length assertion above has already reported honestly, instead
    // of silencing the checker at the index.
    const [row] = rows;
    expect(row?.id).toBe("restart");
    expect(row?.note).toBe("collected");

    driver.close();
  });
});
