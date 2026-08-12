import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { installGatewaySchema } from "./gateway-schema.js";

describe("gateway sharing schema", () => {
  test("legacy copied link routes fail closed instead of gaining a compatibility path", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(
      "CREATE TABLE vault_links (link_id TEXT PRIMARY KEY, route_a_json TEXT)"
    );
    expect(() => installGatewaySchema(database)).toThrow(
      /unsupported pre-#750 gateway\.db sharing schema.*erase and re-onboard/u
    );
    database.close();
  });
});
