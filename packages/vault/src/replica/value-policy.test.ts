import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { VAULT_ENTITIES } from "../schema/entity-catalog.js";
import { DEFAULT_REPLICA_TEXT_CEILING_BYTES } from "../schema/entity-declaration.js";
import { readReplicaRow, readReplicaRows } from "./snapshot.js";
import { replicaValuePolicyOf } from "./value-policy.js";

/** A note body as the product writes it: a `data:` URI on a content item. */
function seedNoteBody(db: VaultDb, id: string, bodyBytes: number): string {
  const body = "a".repeat(bodyBytes);
  const uri = `data:text/markdown;base64,${Buffer.from(body, "utf8").toString("base64")}`;
  db.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, created_at)
       VALUES (?, 'text/markdown', ?, ?, ?, 'Long note', '2026-01-01T00:00:00.000Z')`
    )
    .run(id, uri, "f".repeat(64), Buffer.byteLength(body));
  return uri;
}

describe("replica value policy (#922, SB-text)", () => {
  test("a note body far over the old 64 KiB cap rides in full", () => {
    const db = openVaultDb();
    try {
      // 200 KiB of prose: over the pre-#922 flat cap by 3x, and the shape of
      // the 30 notes the golden year-3 vault plants for exactly this.
      const uri = seedNoteBody(db, "note-body-long", 200 * 1_024);
      expect(Buffer.byteLength(uri)).toBeGreaterThan(
        DEFAULT_REPLICA_TEXT_CEILING_BYTES
      );

      const page = readReplicaRows(db.vault, "core.content_item");
      const row = page.rows.find(
        (candidate) => candidate.rowId === "note-body-long"
      );
      expect(row?.deferredColumns).toStrictEqual([]);
      expect(row?.values["content_uri"]).toBe(uri);

      // The single-row read a change frame takes must agree with the page.
      const lazy = readReplicaRow(
        db.vault,
        "core.content_item",
        "note-body-long"
      );
      expect(lazy?.values["content_uri"]).toBe(uri);
    } finally {
      db.close();
    }
  });

  test("a declared ceiling overrides the caller's baseline in both directions", () => {
    const db = openVaultDb();
    try {
      seedNoteBody(db, "note-body-baseline", 200 * 1_024);
      // A caller asking for a tiny baseline still gets the entity's declared
      // ceiling: the declaration is a fact about the table, not about a read.
      const page = readReplicaRows(db.vault, "core.content_item", {
        maxValueBytes: 8,
      });
      expect(page.rows[0]?.deferredColumns).toStrictEqual([]);

      // An entity that declares nothing keeps the caller's baseline.
      db.vault
        .prepare(
          `INSERT INTO locker_item (item_id, type, title, notes, created_at, updated_at)
           VALUES ('undeclared', 'login', 'Bank', 'more than eight bytes', 't', 't')`
        )
        .run();
      const undeclared = readReplicaRows(db.vault, "locker.item", {
        maxValueBytes: 8,
      });
      expect(undeclared.rows[0]?.deferredColumns).toContain("notes");
    } finally {
      db.close();
    }
  });

  test("a column declared lazy is deferred whatever it weighs", () => {
    const db = openVaultDb();
    try {
      expect(replicaValuePolicyOf("enrich.embedding").lazyColumns).toContain(
        "vector"
      );
      seedNoteBody(db, "embedded-note", 32);
      db.vault
        .prepare(
          `INSERT INTO enrich_embedding
             (embedding_id, target_type, target_id, model, dim, vector, created_at)
           VALUES ('e-1', 'core.content_item', 'embedded-note', 'm', 2, ?,
                   '2026-01-01T00:00:00.000Z')`
        )
        .run(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

      const page = readReplicaRows(db.vault, "enrich.embedding");
      expect(page.rows[0]?.deferredColumns).toContain("vector");
      expect(page.rows[0]?.values).not.toHaveProperty("vector");
    } finally {
      db.close();
    }
  });

  test("every BLOB column on a registered entity is declared lazy", () => {
    const db = openVaultDb();
    try {
      const undeclared: string[] = [];
      for (const [schema, entities] of Object.entries(VAULT_ENTITIES)) {
        for (const table of Object.keys(entities)) {
          const info = db.vault
            .prepare(`PRAGMA table_info("${schema}_${table}")`)
            .all() as unknown as Array<{ name: string; type: string }>;
          const lazy = replicaValuePolicyOf(`${schema}.${table}`).lazyColumns;
          for (const column of info) {
            if (column.type.toUpperCase() !== "BLOB") continue;
            if (!lazy.has(column.name))
              undeclared.push(`${schema}.${table}.${column.name}`);
          }
        }
      }
      // A binary column that no declaration names would fall through to the
      // `Uint8Array` safety net and never be reasoned about; the registry is
      // the one place a reader can find out which values are bytes.
      expect(undeclared).toStrictEqual([]);
    } finally {
      db.close();
    }
  });
});
