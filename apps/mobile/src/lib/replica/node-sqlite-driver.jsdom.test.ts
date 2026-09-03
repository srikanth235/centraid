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

    const rows = driver.all<{ id: string; note: string }>("SELECT * FROM pin");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.id).toBe("restart");
    expect(row?.note).toBe("collected");

    driver.close();
  });
});
// @vitest-environment jsdom
