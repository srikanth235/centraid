// What a FRESH vault is, after #916 closed the v0 ontology's last
// inconsistencies — the OWNER DECISIONS (brief D1–D4) and the end-to-end
// effects that fall out of them (E1–E3).
//
// Every assertion here reads the composed BASELINE — the DDL modules
// themselves — rather than a file walked forward through a ladder. v0 has no
// files in the field, so a shape the baseline can simply state does not need a
// rung that reconstructs it, and a test that walks a rung to find out what the
// vault is would be testing the reconstruction instead of the decision.
//
// The suite is organised by what it protects, not by which module changed:
// each block names the review finding or owner decision it holds, so a shape
// that quietly reverts fails under the reason it was chosen. Its sibling,
// `ontology-rules.test.ts`, holds the review's numbered rules (R1–R13).

import { describe, expect, it } from "vitest";

import { ONTOLOGY_PACKS } from "./atlas.js";
import {
  BASELINE_NOW as NOW,
  baselineVault,
  columnsOf,
  indexesOf,
  onDeleteOf,
  party,
  tableSql,
} from "./baseline-fixture.js";
import { VAULT_ENTITIES } from "./entity-catalog.js";
import { revisionPolicyOf } from "./entity-declaration.js";
import { ENTITY_POINTERS, ENTITY_REF_EXCLUSIONS } from "./entity-refs.js";

describe("D1 — a party is trashed and then purged", () => {
  it("carries the trash pair with the same guard every other trash table has", () => {
    const db = baselineVault();
    expect(columnsOf(db, "core_party")).toStrictEqual(
      expect.arrayContaining(["deleted_at", "purge_at"])
    );
    party(db, "p1");
    expect(() =>
      db
        .prepare(`UPDATE core_party SET purge_at = ? WHERE party_id = 'p1'`)
        .run(NOW)
    ).toThrow(/CHECK/u);
    db.prepare(
      `UPDATE core_party SET deleted_at = ?, purge_at = ? WHERE party_id = 'p1'`
    ).run(NOW, NOW);
    expect(indexesOf(db, "core_party")).toContain("core_party_purge_idx");
  });

  it("purges when nothing names the person, and pure attribution yields", () => {
    const db = baselineVault();
    party(db, "p1");
    db.prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES ('s1', 'urn:s', 'S', '1')`
    ).run();
    db.prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json)
       VALUES ('c1', 's1', 'n', 'N', '[]')`
    ).run();
    db.prepare(
      `INSERT INTO core_place (place_id, name, created_at) VALUES ('pl1', 'Home', ?)`
    ).run(NOW);
    db.prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, tagged_at)
       VALUES ('t1', 'core.place', 'pl1', 'c1', 'p1', ?)`
    ).run(NOW);
    // The tag survives the tagger; it just stops naming one. (A tag ON the
    // person would go with them — that is the supertype cascade, not this.)
    db.prepare(`DELETE FROM core_party WHERE party_id = 'p1'`).run();
    const tag = db
      .prepare(
        `SELECT tagged_by_party_id AS a FROM core_tag WHERE tag_id = 't1'`
      )
      .get() as { a: string | null } | undefined;
    expect(tag?.a).toBeNull();
  });

  it("refuses the purge while money still names the person", () => {
    const db = baselineVault();
    party(db, "payer");
    party(db, "friend");
    db.prepare(
      `INSERT INTO tally_settlement (settlement_id, group_id, from_party, to_party, amount_minor, currency, paid_on, created_at, updated_at)
       VALUES ('s1', NULL, 'payer', 'friend', 100, 'EUR', ?, ?, ?)`
    ).run(NOW, NOW, NOW);
    expect(() =>
      db.prepare(`DELETE FROM core_party WHERE party_id = 'payer'`).run()
    ).toThrow(/FOREIGN KEY/u);
  });

  it("declares the SET NULL columns the audit chose, and no others", () => {
    const db = baselineVault();
    expect(onDeleteOf(db, "core_tag", "tagged_by_party_id")).toBe("SET NULL");
    expect(onDeleteOf(db, "core_content_item", "creator_party_id")).toBe(
      "SET NULL"
    );
    expect(onDeleteOf(db, "core_entity_revision", "actor_party_id")).toBe(
      "SET NULL"
    );
    expect(onDeleteOf(db, "core_event", "organizer_party_id")).toBe("SET NULL");
    expect(onDeleteOf(db, "media_face_region", "party_id")).toBe("SET NULL");
    // Held back by a CHECK that a SET NULL would break mid-delete.
    expect(onDeleteOf(db, "media_face_region", "confirmed_by_party_id")).toBe(
      "NO ACTION"
    );
    expect(onDeleteOf(db, "social_message", "sender_party_id")).toBe(
      "NO ACTION"
    );
    // Money and authority hold the line.
    expect(onDeleteOf(db, "tally_expense", "paid_by")).toBe("NO ACTION");
    expect(onDeleteOf(db, "access_grant", "granted_by_party_id")).toBe(
      "NO ACTION"
    );
  });
});

describe("D2 — one revision mechanism", () => {
  it("has no locker_item_history table", () => {
    const db = baselineVault();
    expect(() => tableSql(db, "locker_item_history")).toThrow(/no such table/u);
    expect(VAULT_ENTITIES.locker?.item_history).toBeUndefined();
  });

  it("joins a revision to the invocation that caused it", () => {
    const db = baselineVault();
    expect(columnsOf(db, "core_entity_revision")).toContain("invocation_id");
    expect(indexesOf(db, "core_entity_revision")).toContain(
      "core_entity_revision_invocation_idx"
    );
  });

  it("declares retention per entity, with the Locker keeping everything", () => {
    expect(revisionPolicyOf(VAULT_ENTITIES.locker!.item!)).toStrictEqual({
      retain: "forever",
    });
    expect(
      revisionPolicyOf(VAULT_ENTITIES.locker!.item_passkey!)
    ).toStrictEqual({
      retain: "forever",
    });
    // Everything else takes the declared default rather than a per-caller guess.
    expect(revisionPolicyOf(VAULT_ENTITIES.core!.event!).retain).toBeTypeOf(
      "number"
    );
  });
});

describe("D3 — recurring splits are rows", () => {
  it("has no splits_json, and a split table keyed like the expense's", () => {
    const db = baselineVault();
    expect(columnsOf(db, "tally_recurring_expense")).not.toContain(
      "splits_json"
    );
    expect(columnsOf(db, "tally_recurring_expense_split")).toStrictEqual([
      "template_id",
      "party_id",
      "share_minor",
      "created_at",
      "updated_at",
    ]);
    expect(onDeleteOf(db, "tally_recurring_expense_split", "template_id")).toBe(
      "CASCADE"
    );
    // A share is money: it refuses the purge of the person who owes it.
    expect(onDeleteOf(db, "tally_recurring_expense_split", "party_id")).toBe(
      "NO ACTION"
    );
  });
});

describe("D4 — the access plane", () => {
  it("names every table access_*, and none consent_*", () => {
    const db = baselineVault();
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'consent_%'`
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toStrictEqual([]);
    for (const t of [
      "access_app",
      "access_agent",
      "access_app_ext",
      "access_grant",
      "access_grant_scope",
      "access_policy",
      "access_device",
      "access_seed_row",
      "access_scope_request",
      "access_scope_tombstone",
    ])
      expect(tableSql(db, t)).toContain(t);
  });

  it("carries the plane's evidence stream under the same one name", () => {
    const db = baselineVault();
    expect(tableSql(db, "access_receipt")).toContain("access_receipt");
    expect(tableSql(db, "access_provenance")).toContain("access_provenance");
  });
});

describe("E1 — a queued artifact about a purged row does not send", () => {
  it("makes the outbox target a real reference that cascades", () => {
    const db = baselineVault();
    expect(tableSql(db, "outbox_item")).toContain(
      "FOREIGN KEY (target_type, target_id)"
    );
    expect(indexesOf(db, "outbox_item")).toContain("idx_outbox_item_target");
    expect(ENTITY_POINTERS.some((p) => p.table === "outbox_item")).toBe(true);
    expect(ENTITY_REF_EXCLUSIONS.has("outbox_item")).toBe(false);
  });
});

describe("E2 — a purge revokes, it does not erase", () => {
  it("stamps every live answer about the purged subject", () => {
    const db = baselineVault();
    party(db, "p1");
    party(db, "owner");
    db.prepare(
      `INSERT INTO share_authority (authority_id, principal_kind, principal_id, subject_type, subject_id, verb, duration, decision, granted_at, granted_by)
       VALUES ('a1','person','p1','core.party','owner','view','standing','granted', ?, 'owner')`
    ).run(NOW);
    db.prepare(
      `INSERT INTO share_authority (authority_id, principal_kind, principal_id, subject_type, subject_id, verb, duration, decision, granted_at, granted_by)
       VALUES ('a2','person','owner','core.party','p1','edit','standing','granted', ?, 'owner')`
    ).run(NOW);
    db.prepare(`DELETE FROM core_entity WHERE entity_id = 'p1'`).run();
    const rows = db
      .prepare(
        `SELECT authority_id AS id, revoked_at AS at, revoked_reason AS why
           FROM share_authority ORDER BY authority_id`
      )
      .all() as { id: string; at: string | null; why: string | null }[];
    // Both survive as history; both are revoked, each for its own reason.
    expect(rows).toHaveLength(2);
    expect(rows[0]?.why).toBe("principal-purged");
    expect(rows[1]?.why).toBe("subject-purged");
    // An ISO stamp, not just non-empty: `revoked_at` is the live-grant filter.
    for (const row of rows)
      expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
  });
});

describe("E3 — the projection rule, mechanically", () => {
  /** Ontology-pack entities, as [logical, physical, declaration]. */
  const ontologyEntities = Object.entries(VAULT_ENTITIES)
    .filter(([schema]) => ONTOLOGY_PACKS.includes(schema))
    .flatMap(([schema, entities]) =>
      Object.entries(entities).map(
        ([table, declaration]) =>
          [`${schema}.${table}`, `${schema}_${table}`, declaration] as const
      )
    );

  it("gives every ENTITY a single opaque id that is not a parent's key", () => {
    const db = baselineVault();
    for (const [logical, physical, declaration] of ontologyEntities) {
      if (declaration.projectionOf !== undefined) continue;
      const cols = db
        .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
        .all() as { name: string; type: string; pk: number }[];
      const pk = cols.filter((c) => c.pk > 0);
      expect(pk, `${logical}: one primary key column`).toHaveLength(1);
      expect(pk[0]?.type, `${logical}: an opaque TEXT id`).toBe("TEXT");
      const fkColumns = new Set(
        (
          db
            .prepare(`PRAGMA foreign_key_list(${JSON.stringify(physical)})`)
            .all() as { from: string; table: string }[]
        )
          .filter((f) => f.table !== "core_entity")
          .map((f) => f.from)
      );
      expect(
        fkColumns.has(pk[0]!.name),
        `${logical}: an entity's id is its own, never a parent's key`
      ).toBe(false);
    }
  });

  it("keys every PROJECTION by the row it belongs to", () => {
    const db = baselineVault();
    // The one exception, and its reason: an alias's key is a WORD the member
    // chose, and entity ids are one opaque namespace — an alias called
    // "github" must not occupy one (schema/entity.ts).
    const NAMED_EXCEPTION = "locker.item_alias";
    for (const [logical, physical, declaration] of ontologyEntities) {
      const parent = declaration.projectionOf;
      if (parent === undefined) continue;
      if (logical === NAMED_EXCEPTION) continue;
      const pk = (
        db.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
          name: string;
          pk: number;
        }[]
      )
        .filter((c) => c.pk > 0)
        .map((c) => c.name);
      const fks = db
        .prepare(`PRAGMA foreign_key_list(${JSON.stringify(physical)})`)
        .all() as { from: string; table: string }[];
      const parentPhysical =
        parent === "core.entity" ? "core_entity" : parent.replace(".", "_");
      // A projection whose parent is `core.entity` is keyed BY ITS POINTER:
      // the composite `(type, id)`, so it cannot outlive whatever it names.
      const parentKeys =
        parent === "core.entity"
          ? ["target_type", "target_id"]
          : fks.filter((f) => f.table === parentPhysical).map((f) => f.from);
      expect(
        parentKeys.every((c) => pk.includes(c)) && parentKeys.length > 0,
        `${logical}: a projection is keyed by its parent (${parent})`
      ).toBe(true);
    }
    expect(VAULT_ENTITIES.locker?.item_alias?.projectionOf).toBe("locker.item");
  });
});
