// Issue #825 rung three: the grant plane reaching a vault stamped before it.
// The v2 shape is spelled out verbatim rather than reconstructed from the
// current DDL — the point is a file this build did NOT create — and only the
// tables the rung reads are needed, because `migrate()` starts at
// user_version 2 and never runs the baseline (which needs openVaultDb's
// custom SQL functions).
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { migrate, VAULT_MIGRATIONS } from "./migrate.js";

const V2_COMMONS_DDL = `
CREATE TABLE core_party (
  party_id     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT NOT NULL
) STRICT;
CREATE TABLE social_circle_member (
  member_id  TEXT PRIMARY KEY,
  circle_id  TEXT NOT NULL,
  party_id   TEXT NOT NULL REFERENCES core_party(party_id),
  added_at   TEXT NOT NULL,
  capability TEXT NOT NULL DEFAULT 'read'
    CHECK (capability IN ('read','read+write')),
  UNIQUE (circle_id, party_id)
) STRICT;
CREATE INDEX idx_circle_member_party ON social_circle_member(party_id);
CREATE TABLE share_party_vault_binding (
  binding_id TEXT PRIMARY KEY,
  party_id   TEXT NOT NULL REFERENCES core_party(party_id),
  vault_id   TEXT NOT NULL,
  linked_at  TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (party_id, vault_id)
) STRICT;
CREATE TABLE share_circle_grant (
  grant_id         TEXT PRIMARY KEY,
  circle_id        TEXT NOT NULL,
  container_type   TEXT NOT NULL,
  container_id     TEXT NOT NULL,
  plane            TEXT NOT NULL CHECK (plane IN ('give','commons')),
  implicit_circle  INTEGER NOT NULL DEFAULT 0 CHECK (implicit_circle IN (0,1)),
  steward_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  created_at       TEXT NOT NULL,
  revoked_at       TEXT,
  max_size_bytes   INTEGER
) STRICT;
CREATE INDEX share_circle_grant_steward ON share_circle_grant(steward_party_id);
CREATE TABLE share_commons_member_state (
  grant_id TEXT NOT NULL REFERENCES share_circle_grant(grant_id),
  party_id TEXT NOT NULL REFERENCES core_party(party_id),
  status   TEXT NOT NULL CHECK (status IN ('invited','current','refused')),
  PRIMARY KEY (grant_id, party_id)
) STRICT;
CREATE INDEX share_commons_member_state_party
  ON share_commons_member_state(party_id);
-- Issue #304's credential sidecar predates this rung, so any real v2 vault
-- carries it — and issue #865's later rung ALTERs it, so the fixture must too.
CREATE TABLE sync_connection_credential (
  connection_id    TEXT PRIMARY KEY,
  cred_kind        TEXT NOT NULL CHECK (cred_kind IN ('oauth2','api_key')),
  oauth_mode       TEXT NOT NULL DEFAULT 'byo' CHECK (oauth_mode IN ('byo','assist')),
  provider         TEXT,
  auth_url         TEXT,
  token_url        TEXT,
  scopes           TEXT,
  client_id        TEXT,
  client_secret    TEXT,
  access_token     TEXT,
  refresh_token    TEXT,
  api_key          TEXT,
  token_expires_at TEXT,
  allowed_hosts    TEXT NOT NULL CHECK (json_valid(allowed_hosts)),
  updated_at       TEXT NOT NULL
) STRICT;
`;

/*
 * One steward and five audience parties, arranged so the rung has to make
 * every decision it can make:
 *   - `circle-family` is NAMED and its live members agree on 'read', so the
 *     grant stays ONE circle-audience grant at 'view';
 *   - `circle-work` is NAMED but carol edits and dave only reads, so no single
 *     circle row could be honest and the grant decomposes into party rows;
 *   - `circle-adhoc` is IMPLICIT — an anonymous roster wrapper — so it always
 *     decomposes, and it grants the same subject twice at different
 *     capabilities, which the live-uniqueness index forbids: the stronger one
 *     must win, deterministically;
 *   - `circle-club` is NAMED and uniform at 'read', but grace REFUSED — a
 *     circle row would keep reaching her through the roster, so the grant
 *     decomposes and only bob gets a party grant;
 *   - `circle-refused` is NAMED and every member refused, so its live grant
 *     decomposes to nothing and deliberately does not migrate;
 *   - erin refused her invitation, dave's only binding is revoked, and frank
 *     has no binding at all — three different reasons the delivery answer
 *     differs from the permission answer.
 * A revoked grant and a 'give'-plane grant are present to be ignored.
 */
function seedV2Vault(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(V2_COMMONS_DDL);
  db.exec("PRAGMA user_version = 2");
  db.exec(`
INSERT INTO core_party (party_id, kind, display_name) VALUES
  ('party-owner', 'person', 'Owner'),
  ('party-alice', 'person', 'Alice'),
  ('party-bob', 'person', 'Bob'),
  ('party-carol', 'person', 'Carol'),
  ('party-dave', 'person', 'Dave'),
  ('party-erin', 'person', 'Erin'),
  ('party-frank', 'person', 'Frank'),
  ('party-grace', 'person', 'Grace');

INSERT INTO social_circle_member
  (member_id, circle_id, party_id, added_at, capability) VALUES
  ('m1', 'circle-family', 'party-alice', '2024-01-10T00:00:00.000Z', 'read'),
  ('m2', 'circle-family', 'party-bob', '2024-01-10T00:00:00.000Z', 'read'),
  ('m3', 'circle-work', 'party-carol', '2024-01-10T00:00:00.000Z', 'read+write'),
  ('m4', 'circle-work', 'party-dave', '2024-01-10T00:00:00.000Z', 'read'),
  ('m5', 'circle-work', 'party-erin', '2024-01-10T00:00:00.000Z', 'read'),
  ('m6', 'circle-adhoc', 'party-alice', '2024-01-10T00:00:00.000Z', 'read+write'),
  ('m7', 'circle-adhoc', 'party-frank', '2024-01-10T00:00:00.000Z', 'read'),
  ('m9', 'circle-club', 'party-bob', '2024-01-10T00:00:00.000Z', 'read'),
  ('m10', 'circle-club', 'party-grace', '2024-01-10T00:00:00.000Z', 'read'),
  ('m11', 'circle-refused', 'party-grace', '2024-01-10T00:00:00.000Z', 'read');

INSERT INTO share_party_vault_binding
  (binding_id, party_id, vault_id, linked_at, revoked_at) VALUES
  ('bind-alice', 'party-alice', 'vault-alice', '2024-01-01T00:00:00.000Z', NULL),
  ('bind-bob', 'party-bob', 'vault-bob', '2024-01-02T00:00:00.000Z', NULL),
  ('bind-carol', 'party-carol', 'vault-carol', '2024-01-03T00:00:00.000Z', NULL),
  ('bind-dave', 'party-dave', 'vault-dave', '2024-01-04T00:00:00.000Z',
   '2024-06-01T00:00:00.000Z'),
  ('bind-erin', 'party-erin', 'vault-erin', '2024-01-05T00:00:00.000Z', NULL);

INSERT INTO share_circle_grant
  (grant_id, circle_id, container_type, container_id, plane, implicit_circle,
   steward_party_id, created_at, revoked_at, max_size_bytes) VALUES
  ('grant-family', 'circle-family', 'docs.folder', 'folder-1', 'commons', 0,
   'party-owner', '2024-02-01T00:00:00.000Z', NULL, 4096),
  ('grant-work', 'circle-work', 'core.document', 'doc-1', 'commons', 0,
   'party-owner', '2024-02-02T00:00:00.000Z', NULL, NULL),
  ('grant-adhoc-edit', 'circle-adhoc', 'tally.group', 'group-1', 'commons', 1,
   'party-owner', '2024-02-03T00:00:00.000Z', NULL, 512),
  ('grant-adhoc-view', 'circle-adhoc-view', 'tally.group', 'group-1', 'commons',
   1, 'party-owner', '2024-02-04T00:00:00.000Z', NULL, 512),
  ('grant-dead', 'circle-family', 'media.asset', 'asset-1', 'commons', 0,
   'party-owner', '2024-02-05T00:00:00.000Z', '2024-03-01T00:00:00.000Z', NULL),
  ('grant-give', 'circle-family', 'core.collection', 'coll-1', 'give', 0,
   'party-owner', '2024-02-06T00:00:00.000Z', NULL, NULL),
  ('grant-club', 'circle-club', 'media.asset', 'asset-2', 'commons', 0,
   'party-owner', '2024-02-07T00:00:00.000Z', NULL, NULL),
  ('grant-solo', 'circle-refused', 'core.document', 'doc-solo', 'commons', 0,
   'party-owner', '2024-02-08T00:00:00.000Z', NULL, NULL);

INSERT INTO social_circle_member
  (member_id, circle_id, party_id, added_at, capability) VALUES
  ('m8', 'circle-adhoc-view', 'party-alice', '2024-01-10T00:00:00.000Z', 'read');

INSERT INTO share_commons_member_state (grant_id, party_id, status) VALUES
  ('grant-family', 'party-alice', 'current'),
  ('grant-family', 'party-bob', 'invited'),
  ('grant-work', 'party-carol', 'current'),
  ('grant-work', 'party-dave', 'invited'),
  ('grant-work', 'party-erin', 'refused'),
  ('grant-adhoc-edit', 'party-alice', 'current'),
  ('grant-adhoc-edit', 'party-frank', 'invited'),
  ('grant-adhoc-view', 'party-alice', 'current'),
  ('grant-club', 'party-bob', 'current'),
  ('grant-club', 'party-grace', 'refused'),
  ('grant-solo', 'party-grace', 'refused');
`);
}

type GrantShape = {
  audience_kind: string;
  audience_id: string;
  subject_type: string;
  subject_id: string;
  capability: string;
  granted_at: string;
  revoked_at: string | null;
  granted_by: string;
  max_size_bytes: number | null;
};

/**
 * node:sqlite hands back null-prototype rows; `toStrictEqual` compares
 * prototypes, so every row read in this file is re-shaped as a plain object
 * before it is asserted on.
 */
function plainRows<T>(rows: readonly T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

function query(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return plainRows(db.prepare(sql).all() as Record<string, unknown>[]);
}

function grantShapes(db: DatabaseSync): GrantShape[] {
  return plainRows(
    db
      .prepare(
        `SELECT audience_kind, audience_id, subject_type, subject_id, capability,
                granted_at, revoked_at, granted_by, max_size_bytes
           FROM share_grant
          ORDER BY audience_kind, audience_id, subject_type, subject_id`
      )
      .all() as GrantShape[]
  );
}

function commonsSnapshot(db: DatabaseSync): Record<string, unknown[]> {
  return {
    grants: query(db, `SELECT * FROM share_circle_grant ORDER BY grant_id`),
    members: query(
      db,
      `SELECT * FROM social_circle_member ORDER BY circle_id, party_id`
    ),
    states: query(
      db,
      `SELECT * FROM share_commons_member_state ORDER BY grant_id, party_id`
    ),
    bindings: query(
      db,
      `SELECT * FROM share_party_vault_binding ORDER BY binding_id`
    ),
  };
}

describe("schema/migrate rung three (issue #825 grant plane)", () => {
  test("restates live commons grants as standing grants, losing nothing", () => {
    const db = new DatabaseSync(":memory:");
    seedV2Vault(db);
    const commonsBefore = commonsSnapshot(db);

    migrate(db, VAULT_MIGRATIONS);

    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version
    ).toBe(5);

    expect(grantShapes(db)).toStrictEqual([
      // The uniform named circle stays ONE circle-audience grant.
      {
        audience_kind: "circle",
        audience_id: "circle-family",
        subject_type: "docs.folder",
        subject_id: "folder-1",
        capability: "view",
        granted_at: "2024-02-01T00:00:00.000Z",
        revoked_at: null,
        granted_by: "party-owner",
        max_size_bytes: 4096,
      },
      // The implicit circle's two grants over one subject collapse to the
      // stronger capability, and alice keeps the ceiling that came with it.
      {
        audience_kind: "party",
        audience_id: "party-alice",
        subject_type: "tally.group",
        subject_id: "group-1",
        capability: "edit",
        granted_at: "2024-02-03T00:00:00.000Z",
        revoked_at: null,
        granted_by: "party-owner",
        max_size_bytes: 512,
      },
      // The uniform named circle with a refusal decomposes: a circle row
      // would keep reaching grace through the roster, so bob alone carries it.
      {
        audience_kind: "party",
        audience_id: "party-bob",
        subject_type: "media.asset",
        subject_id: "asset-2",
        capability: "view",
        granted_at: "2024-02-07T00:00:00.000Z",
        revoked_at: null,
        granted_by: "party-owner",
        max_size_bytes: null,
      },
      // The named circle with capability variance decomposes per party.
      {
        audience_kind: "party",
        audience_id: "party-carol",
        subject_type: "core.document",
        subject_id: "doc-1",
        capability: "edit",
        granted_at: "2024-02-02T00:00:00.000Z",
        revoked_at: null,
        granted_by: "party-owner",
        max_size_bytes: null,
      },
      {
        audience_kind: "party",
        audience_id: "party-dave",
        subject_type: "core.document",
        subject_id: "doc-1",
        capability: "view",
        granted_at: "2024-02-02T00:00:00.000Z",
        revoked_at: null,
        granted_by: "party-owner",
        max_size_bytes: null,
      },
      {
        audience_kind: "party",
        audience_id: "party-frank",
        subject_type: "tally.group",
        subject_id: "group-1",
        capability: "view",
        granted_at: "2024-02-03T00:00:00.000Z",
        revoked_at: null,
        granted_by: "party-owner",
        max_size_bytes: 512,
      },
    ]);

    // Erin and grace refused: a refused invitation was never a standing
    // permission, so neither has a grant or a delivery row anywhere — not
    // even through a circle audience, since a refusal forces decomposition.
    for (const refused of ["party-erin", "party-grace"]) {
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM share_grant WHERE audience_id = ?`
          )
          .get(refused)
      ).toMatchObject({ n: 0 });
    }
    // The limit case, deliberately: a live named-circle grant EVERY member
    // refused permits no one and does not migrate. The commons row and the
    // refusals survive untouched (asserted below) as the record.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM share_grant WHERE subject_id = 'doc-solo'`
        )
        .get()
    ).toMatchObject({ n: 0 });
    // The revoked grant and the give-plane grant are not restated.
    for (const subject of ["asset-1", "coll-1"]) {
      expect(
        db
          .prepare(`SELECT COUNT(*) AS n FROM share_grant WHERE subject_id = ?`)
          .get(subject)
      ).toMatchObject({ n: 0 });
    }

    const fulfillment = plainRows(
      db
        .prepare(
          `SELECT g.audience_id AS audience, g.subject_id AS subject,
                f.peer_vault_id AS vault, f.state AS state,
                f.updated_at AS updated_at, f.detail AS detail
           FROM share_fulfillment f
           JOIN share_grant g ON g.grant_id = f.grant_id
          ORDER BY g.audience_id, g.subject_id, f.peer_vault_id`
        )
        .all() as Record<string, unknown>[]
    );
    expect(fulfillment).toStrictEqual([
      // The circle grant fans out to one row per member vault; alice has
      // accepted, bob is still invited over a live channel.
      {
        audience: "circle-family",
        subject: "folder-1",
        vault: "vault-alice",
        state: "delivered",
        updated_at: "2024-02-01T00:00:00.000Z",
        detail: null,
      },
      {
        audience: "circle-family",
        subject: "folder-1",
        vault: "vault-bob",
        state: "syncing",
        updated_at: "2024-02-01T00:00:00.000Z",
        detail: null,
      },
      {
        audience: "party-alice",
        subject: "group-1",
        vault: "vault-alice",
        state: "delivered",
        updated_at: "2024-02-03T00:00:00.000Z",
        detail: null,
      },
      {
        audience: "party-bob",
        subject: "asset-2",
        vault: "vault-bob",
        state: "delivered",
        updated_at: "2024-02-07T00:00:00.000Z",
        detail: null,
      },
      {
        audience: "party-carol",
        subject: "doc-1",
        vault: "vault-carol",
        state: "delivered",
        updated_at: "2024-02-02T00:00:00.000Z",
        detail: null,
      },
      // Dave's only binding is revoked: the peer is known, the channel is not.
      {
        audience: "party-dave",
        subject: "doc-1",
        vault: "vault-dave",
        state: "awaiting_channel",
        updated_at: "2024-02-02T00:00:00.000Z",
        detail: null,
      },
    ]);
    // Frank has a grant but no binding at all, so there is no vault to name
    // and absence of a fulfillment row IS "no channel yet".
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM share_fulfillment f
             JOIN share_grant g ON g.grant_id = f.grant_id
            WHERE g.audience_id = 'party-frank'`
        )
        .get()
    ).toMatchObject({ n: 0 });

    // Every minted grant id is distinct and non-empty.
    expect(
      db
        .prepare(
          `SELECT COUNT(DISTINCT grant_id) AS ids, COUNT(*) AS rows
             FROM share_grant WHERE length(grant_id) = 32`
        )
        .get()
    ).toMatchObject({ ids: 6, rows: 6 });

    // Not one commons row moved: commons is the edit-fulfillment strategy
    // under the grant plane, not a rival record of the same fact.
    expect(commonsSnapshot(db)).toStrictEqual(commonsBefore);
    db.close();
  });

  test("the rung leaves no scaffolding behind and is a no-op on replay", () => {
    const db = new DatabaseSync(":memory:");
    seedV2Vault(db);
    migrate(db, VAULT_MIGRATIONS);
    for (const scaffold of ["share_grant_seed", "share_grant_mint"]) {
      expect(
        db
          .prepare(`SELECT 1 FROM sqlite_temp_master WHERE name = ?`)
          .get(scaffold),
        scaffold
      ).toBeUndefined();
    }
    const after = grantShapes(db);
    migrate(db, VAULT_MIGRATIONS);
    expect(grantShapes(db)).toStrictEqual(after);
    db.close();
  });

  test("a fresh vault gets the tables from the baseline and backfills nothing", () => {
    const db = openVaultDb();
    expect(
      db.vault.prepare(`SELECT COUNT(*) AS n FROM share_grant`).get()
    ).toMatchObject({ n: 0 });
    expect(
      db.vault.prepare(`SELECT COUNT(*) AS n FROM share_fulfillment`).get()
    ).toMatchObject({ n: 0 });
    // The live-uniqueness index and both secondary indexes are real on a
    // fresh file, not only on the upgrade path.
    for (const index of [
      "share_grant_live_audience_subject",
      "share_grant_subject",
      "share_grant_audience",
    ]) {
      expect(
        db.vault
          .prepare(
            `SELECT COUNT(*) AS n FROM sqlite_master
              WHERE type = 'index' AND name = ?`
          )
          .get(index),
        index
      ).toMatchObject({ n: 1 });
    }
    db.close();
  });
});
