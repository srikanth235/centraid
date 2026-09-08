// #922 0b, ruling SB-text: deferred text has a path to the screen, or is not
// deferred. Text now rides the replica lane in full up to the ceiling its
// entity declares (`packages/vault/src/schema/entity-catalog.ts`), so what
// reaches the phone as a deferred column is bytes a column declares lazy — and
// that absence is NAMED, in the sentence both clients print.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, test } from "vitest";

import { fieldNotOnThisDevice } from "@centraid/blueprints/apps/_shared/shared-copy";

import { OnlineOnlyError, OnlineOnlyGuard } from "./errors.js";
import { guardReplicaRow } from "./query.js";
import { SqliteReplicaStore } from "./sqlite-store.js";
import type { ReplicaSnapshot } from "./types.js";

let sqlite3: Sqlite3Static;

/** 200 KiB of prose, base64 in a `data:` URI — a long note body as stored. */
const BODY = "a".repeat(200 * 1_024);
const NOTE_URI = `data:text/markdown;base64,${Buffer.from(BODY, "utf8").toString("base64")}`;

function snapshot(): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: "vault-a",
    schemaEpoch: "schema-1",
    cursor: { epoch: "replica-1", seq: 1 },
    shapes: [
      {
        shapeId: "shape-notes",
        appId: "notes",
        entities: [
          {
            entity: "core.content_item",
            primaryKey: "content_id",
            columns: ["content_id", "title", "content_uri"],
          },
          {
            entity: "enrich.embedding",
            primaryKey: "embedding_id",
            columns: ["embedding_id", "model", "vector"],
          },
        ],
      },
    ],
    rows: [
      {
        shapeId: "shape-notes",
        entity: "core.content_item",
        rowId: "long-note",
        values: {
          content_id: "long-note",
          title: "Long note",
          content_uri: NOTE_URI,
        },
      },
      {
        shapeId: "shape-notes",
        entity: "enrich.embedding",
        rowId: "embedding-1",
        values: { embedding_id: "embedding-1", model: "m" },
        oversizedFields: ["vector"],
      },
    ],
  };
}

describe("deferred values on the device", () => {
  beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
  });

  function bootstrapped(): SqliteReplicaStore {
    const db = new sqlite3.oo1.DB(":memory:", "c");
    const store = new SqliteReplicaStore(db, "vault-a");
    store.bootstrap(snapshot());
    return store;
  }

  test("a note body over the old 64 KiB cap is on the device in full", () => {
    const store = bootstrapped();
    const result = store.read({
      shapeId: "shape-notes",
      entity: "core.content_item",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.oversizedFields).toStrictEqual([]);
    // Byte-for-byte, not merely present: a truncated body is a wrong body.
    expect(result.rows[0]?.values["content_uri"]).toBe(NOTE_URI);
    expect(
      String(result.rows[0]?.values["content_uri"]).length
    ).toBeGreaterThan(64 * 1_024);
  });

  test("a lazy column is absent AND says so when a screen reaches for it", () => {
    const store = bootstrapped();
    const result = store.read({
      shapeId: "shape-notes",
      entity: "enrich.embedding",
    });
    const envelope = result.rows[0]!;
    expect(envelope.oversizedFields).toStrictEqual(["vector"]);
    expect(envelope.values).not.toHaveProperty("vector");

    const guard = new OnlineOnlyGuard();
    const row = guardReplicaRow(envelope, guard);
    // Reading it is a refusal that NAMES the field, not `undefined`: the
    // absence reaches the screen instead of being silently rendered as empty.
    expect(() => row["vector"]).toThrow(OnlineOnlyError);
    expect(() => row["vector"]).toThrow(fieldNotOnThisDevice("vector"));
    expect(row["model"]).toBe("m");
  });
});
