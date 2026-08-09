/*
 * The borrowed store's two load-bearing properties (#726 P4 D4): dropping a
 * shape leaves NOTHING behind — including in the FTS5 shadow tables, which do
 * not cascade — and the whole slot sits outside every vault directory, which
 * is what keeps borrowed rows out of vault.db, the journal, and any backup.
 */

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  borrowedCasRoot,
  borrowedRoot,
  borrowedStoreFile,
} from "./borrowed-paths.js";
import { BorrowedStore } from "./borrowed-store.js";

function openStore(): { store: BorrowedStore; file: string } {
  const dataDir = tempDirSync("centraid-borrowed-store-");
  const file = borrowedStoreFile(dataDir, "vlt_peer");
  const store = BorrowedStore.open(file);
  store.beginBootstrap({
    shapeId: "shape-1",
    edgeId: "edge-1",
    originVaultId: "vlt_peer",
    appId: "lent:party-1",
    purpose: "dpv:ServiceProvision",
    schemaEpoch: "1",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    entities: [
      {
        entity: "core.collection",
        primaryKey: "collection_id",
        columns: ["collection_id", "name"],
      },
    ],
  });
  store.applyPage([
    {
      shapeId: "shape-1",
      entity: "core.collection",
      rowId: "c1",
      values: { collection_id: "c1", name: "Groceries" },
    },
  ]);
  store.commitBootstrap("shape-1", { epoch: "e1", seq: 4 });
  return { store, file };
}

describe("the borrowed store", () => {
  it("keys meta and shapes per SHAPE, not per store — one file, many edges", () => {
    const { store } = openStore();
    const shape = store.shapeForEdge("edge-1")!;
    expect(shape).toMatchObject({
      shapeId: "shape-1",
      originVaultId: "vlt_peer",
      cursor: { epoch: "e1", seq: 4 },
    });
    // The three columns store-core's `replica_shape` does not have.
    expect(shape.edgeId).toBe("edge-1");
    expect(shape.leaseExpiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("sweeps the FTS index and the gap ledger in the same transaction as the rows", () => {
    const { store, file } = openStore();
    const found = store.search("shape-1", "Groceries");
    expect(found.rows).toHaveLength(1);
    expect(found.refusedEntities).toStrictEqual([]);

    store.dropShape("shape-1");

    expect(store.shapeForEdge("edge-1")).toBeUndefined();
    expect(store.rowCount("shape-1")).toBe(0);
    // Reach past the API: an FTS5 table has no foreign key to cascade from,
    // so a shape delete that forgot it would leave the borrowed text behind
    // and searchable.
    const raw = store.handle;
    for (const table of [
      "replica_search",
      "replica_search_gap",
      "replica_entity_schema",
      "replica_meta",
    ]) {
      expect(
        raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()
      ).toMatchObject({ n: 0 });
    }
    store.close();

    const reopened = new DatabaseSync(file);
    expect(reopened.prepare("PRAGMA auto_vacuum").get()).toMatchObject({
      auto_vacuum: 2,
    });
    reopened.close();
  });

  it("search REFUSES an entity whose field mask excluded a column, never a silent under-search (#726 P4 D10)", () => {
    const dataDir = tempDirSync("centraid-borrowed-store-refuse-");
    const store = BorrowedStore.open(borrowedStoreFile(dataDir, "vlt_peer3"));
    store.beginBootstrap({
      shapeId: "shape-3",
      edgeId: "edge-3",
      originVaultId: "vlt_peer3",
      appId: "lent:party-3",
      purpose: "dpv:ServiceProvision",
      schemaEpoch: "1",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      entities: [
        {
          entity: "core.collection",
          primaryKey: "collection_id",
          columns: ["collection_id", "name"],
        },
        // The origin's mask excluded a column this entity actually has.
        {
          entity: "core.document",
          primaryKey: "document_id",
          columns: ["document_id"],
          hasUnavailableFields: true,
        },
      ],
    });
    store.applyPage([
      {
        shapeId: "shape-3",
        entity: "core.collection",
        rowId: "c1",
        values: { collection_id: "c1", name: "Groceries" },
      },
      {
        shapeId: "shape-3",
        entity: "core.document",
        rowId: "d1",
        values: { document_id: "d1" },
      },
    ]);
    store.commitBootstrap("shape-3", { epoch: "e1", seq: 1 });

    expect(store.searchableEntities("shape-3").refused).toStrictEqual([
      "core.document",
    ]);
    const found = store.search("shape-3", "Groceries");
    expect(found.rows.map((row) => row.entity)).toStrictEqual([
      "core.collection",
    ]);
    // Named explicitly, not folded into "no matches" — even though this
    // particular masked row happened to carry no searchable text anyway.
    expect(found.refusedEntities).toStrictEqual(["core.document"]);
  });

  it("lives outside every vault directory — the invariant is the address", () => {
    const dataDir = "/var/centraid";
    // Backup sources are rooted at `<vaultDir>/…` (backup-sources.ts); the
    // borrowed slot is a SIBLING of the vault root, so no filter is needed and
    // none exists.
    const vaultDir = path.join(dataDir, "vaults");
    expect(borrowedRoot(dataDir).startsWith(vaultDir)).toBe(false);
    expect(borrowedStoreFile(dataDir, "vlt_peer")).toContain(
      borrowedRoot(dataDir)
    );
    expect(borrowedCasRoot(dataDir, "vlt_peer")).toContain(
      borrowedRoot(dataDir)
    );
    // A peer vault id arrives off a link row, so the slug is derived rather
    // than trusted — no traversal reaches out of the slot.
    expect(borrowedStoreFile(dataDir, "../../etc/passwd")).toContain(
      borrowedRoot(dataDir)
    );
    expect(borrowedStoreFile(dataDir, "../../etc/passwd")).not.toContain("..");
  });
});
