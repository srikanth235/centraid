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

    expect(
      driver.all<{ id: string; note: string }>("SELECT * FROM pin")
    ).toStrictEqual([{ id: "restart", note: "collected" }]);

    driver.close();
  });
});
