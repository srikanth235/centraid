/*
 * `searchReachFor` (#726 P4 item 7, D10) — the mask-selection-time twin of
 * `borrowed-store.ts`'s query-time refusal. Both ask the SAME question
 * ("does this mask exclude a column the physical table has"); this one asks
 * it before the edge is even lent.
 */

import { describe, expect, it } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";
import { bootstrapVault, openVaultDb } from "@centraid/vault";

import { searchReachFor } from "./lend-search-reach.js";

describe("searchReachFor (#726 P4 D10)", () => {
  it("names a scope whose mask excludes a column the table actually has", () => {
    const { db } = bootstrappedVault({ openVaultDb, bootstrapVault });

    const reach = searchReachFor(db.vault, [
      {
        schema: "core",
        table: "collection",
        fieldMask: ["collection_id", "name"],
      },
    ]);

    expect(reach).toStrictEqual([
      { schema: "core", table: "collection", masksSearchableColumns: true },
    ]);
  });

  it("says a full mask (no fieldMask at all) masks nothing", () => {
    const { db } = bootstrappedVault({ openVaultDb, bootstrapVault });

    const reach = searchReachFor(db.vault, [
      { schema: "core", table: "collection" },
    ]);

    expect(reach).toStrictEqual([
      { schema: "core", table: "collection", masksSearchableColumns: false },
    ]);
  });

  it("fails soft — 'cannot tell', never a throw — for an unresolvable scope", () => {
    const { db } = bootstrappedVault({ openVaultDb, bootstrapVault });

    const reach = searchReachFor(db.vault, [
      { schema: "not_a_schema", table: "nope", fieldMask: ["x"] },
      { schema: "core", table: undefined, fieldMask: ["x"] },
    ]);

    expect(reach).toStrictEqual([
      { schema: "not_a_schema", table: "nope", masksSearchableColumns: false },
      { schema: "core", table: "", masksSearchableColumns: false },
    ]);
  });

  it("preserves scope order and covers every scope, one entry each", () => {
    const { db } = bootstrappedVault({ openVaultDb, bootstrapVault });

    const reach = searchReachFor(db.vault, [
      { schema: "core", table: "collection", fieldMask: ["collection_id"] },
      { schema: "core", table: "collection_entry" },
    ]);

    expect(reach.map((row) => row.table)).toStrictEqual([
      "collection",
      "collection_entry",
    ]);
    expect(reach[1]).toStrictEqual({
      schema: "core",
      table: "collection_entry",
      masksSearchableColumns: false,
    });
  });
});
