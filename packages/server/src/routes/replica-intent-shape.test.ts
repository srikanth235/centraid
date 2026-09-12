// THE GATEWAY'S HALF OF THE CANONICAL PAYLOAD (#1014, C20).
//
// `expectedPayloadHash` hashes `baseVersions` in the order `parseBaseVersions`
// produced, and the seat hashes them in the order
// `packages/client/src/replica/payload-hash.ts` produced. The two orders are
// the contract: a divergence is a `replica_intent_hash_mismatch` on a
// well-formed write, and the digest below is the same fixture the client test
// pins, so a change on either side fails on both.

import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { migrate, VAULT_MIGRATIONS } from "@centraid/vault";

import {
  expectedPayloadHash,
  originConflict,
  parseBaseVersions,
} from "./replica-intent-shape.js";

describe("base version ordering in the canonical payload", () => {
  test("sorts by code point, not by locale", () => {
    // The divergence itself: ICU collation puts "a" before "B".
    expect("a".localeCompare("B")).toBeLessThan(0);
    const parsed = parseBaseVersions([
      { entity: "media.asset", rowId: "a1", version: 2 },
      { entity: "media.asset", rowId: "B1", version: 5 },
    ]);
    expect(parsed.map((base) => base.rowId)).toStrictEqual(["B1", "a1"]);
  });

  test("pins the digest the seat computes for the same payload", () => {
    const parsed = parseBaseVersions([
      { entity: "media.asset", rowId: "a1", version: 2 },
      { entity: "media.asset", rowId: "B1", version: 5 },
    ]);
    expect(
      expectedPayloadHash("photos", "update-asset", { asset_id: "a1" }, parsed)
    ).toBe("6984dd9170404c63cc70a4f109ef8cd713bcbff03800158992e5fd072f601f9e");
  });
});

/*
 * THE ORIGIN'S OWN CHECK FOR A MEMBER'S SIGNED WRITE (#1014, V7).
 *
 * A member's envelope names the ORIGIN's ids — `forwardOverPeer` translates
 * them out of lineage — so the check is the row's own version against the one
 * the member composed against, with no shape to resolve through. Before this
 * the origin parsed `baseVersions` and never looked at it: two members editing
 * one shared album was last writer wins.
 */
describe("a member intent's base versions at the origin", () => {
  function vaultWithPlace(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    migrate(db, VAULT_MIGRATIONS);
    db.prepare(
      `INSERT INTO core_entity (entity_id, entity_type, created_at)
       VALUES ('p1', 'core.place', '2026-01-01')`
    ).run();
    db.prepare(
      `INSERT INTO core_place (place_id, name, created_at)
       VALUES ('p1', 'The lake house', '2026-01-01')`
    ).run();
    return db;
  }

  test("says nothing when the row is still where the member left it", () => {
    const db = vaultWithPlace();
    expect(
      originConflict(db, [{ entity: "core.place", rowId: "p1", version: 1 }])
    ).toBeUndefined();
  });

  test("names the row, the expected version and the actual one", () => {
    const db = vaultWithPlace();
    db.prepare(
      `UPDATE core_place SET name = 'The cabin' WHERE place_id = 'p1'`
    ).run();
    expect(
      originConflict(db, [{ entity: "core.place", rowId: "p1", version: 1 }])
    ).toStrictEqual({
      entity: "core.place",
      rowId: "p1",
      expectedVersion: 1,
      actualVersion: 2,
    });
  });

  test("a row that is gone answers zero, which conflicts with any version", () => {
    const db = vaultWithPlace();
    db.prepare(`DELETE FROM core_place WHERE place_id = 'p1'`).run();
    expect(
      originConflict(db, [{ entity: "core.place", rowId: "p1", version: 1 }])
    ).toStrictEqual({
      entity: "core.place",
      rowId: "p1",
      expectedVersion: 1,
      actualVersion: 0,
    });
  });

  test("an envelope that states no base version states no precondition", () => {
    expect(originConflict(vaultWithPlace(), [])).toBeUndefined();
  });
});
