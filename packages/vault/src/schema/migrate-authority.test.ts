// Rung six (#883) on a vault stamped before it. The v5 shape is spelled out
// verbatim rather than reconstructed from the current DDL: the point of the
// test is a file this build did NOT create.
//
// The claim is LOSSLESSNESS, asserted the only way that means anything — every
// legacy row is tabled against the authority row it must become, and the WHOLE
// landed table is compared to the whole expectation, so a silently dropped row
// fails here instead of slipping past a per-row spot check.
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { migrate, VAULT_MIGRATIONS } from "./migrate.js";

// Walked to rung SIX, not to the top: the assertions here are the shape rung
// six produced. Rung seven has its own test (`migrate-reconcile.test.ts`).
const RUNGS_THROUGH_SIX = VAULT_MIGRATIONS.slice(0, 6);

const V5_AUTHORITY_DDL = `
CREATE TABLE core_party (
  party_id     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT NOT NULL
) STRICT;
CREATE TABLE share_grant (
  grant_id       TEXT PRIMARY KEY,
  audience_kind  TEXT NOT NULL CHECK (audience_kind IN ('party','circle')),
  audience_id    TEXT NOT NULL,
  subject_type   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  capability     TEXT NOT NULL CHECK (capability IN ('view','edit')),
  granted_at     TEXT NOT NULL,
  revoked_at     TEXT,
  granted_by     TEXT NOT NULL REFERENCES core_party(party_id),
  max_size_bytes INTEGER CHECK (max_size_bytes IS NULL OR max_size_bytes >= 0)
) STRICT;
CREATE UNIQUE INDEX share_grant_live_audience_subject
  ON share_grant(audience_kind, audience_id, subject_type, subject_id)
  WHERE revoked_at IS NULL;
CREATE TABLE share_fulfillment (
  grant_id      TEXT NOT NULL REFERENCES share_grant(grant_id) ON DELETE CASCADE,
  peer_vault_id TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN
    ('awaiting_channel','syncing','delivered','remove_sent','removed')),
  updated_at    TEXT NOT NULL,
  detail        TEXT,
  delivered_at  TEXT,
  PRIMARY KEY (grant_id, peer_vault_id)
) STRICT;
CREATE TABLE enrich_consent (
  consent_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL CHECK (length(capability) BETWEEN 1 AND 64),
  egress     TEXT NOT NULL CHECK (egress IN ('on-device','gateway','provider')),
  scope_ref  TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK (decision IN ('granted','declined')),
  decided_at TEXT NOT NULL,
  receipt_id TEXT,
  UNIQUE (capability, egress, scope_ref)
) STRICT;
CREATE TABLE consent_device (
  device_id      TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  platform       TEXT,
  public_key     TEXT NOT NULL UNIQUE,
  trust          TEXT NOT NULL CHECK (trust IN ('full','readonly','revoked')),
  enrolled_at    TEXT NOT NULL,
  last_seen_at   TEXT,
  sync_cursor    TEXT
) STRICT;
CREATE INDEX idx_device_owner_party ON consent_device(owner_party_id);
-- A child of consent_device, so the rung's table rebuild has a real foreign key
-- to keep whole rather than a hypothetical one.
CREATE TABLE blob_device_wrap_key (
  device_id  TEXT PRIMARY KEY REFERENCES consent_device(device_id) ON DELETE CASCADE,
  salt       BLOB NOT NULL,
  key_epoch  INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

// Every shape the rung can be handed, once each — including the edge values a
// `?? default` would erase (a ZERO ceiling) and the ones an absence would hide
// (a revoked grant, a declined egress answer, a revoked device).
function seedV5Vault(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(V5_AUTHORITY_DDL);
  db.exec("PRAGMA user_version = 5");
  db.exec(`
INSERT INTO core_party (party_id, kind, display_name) VALUES
  ('party-owner', 'person', 'Owner'),
  ('party-alice', 'person', 'Alice');

INSERT INTO share_grant
  (grant_id, audience_kind, audience_id, subject_type, subject_id, capability,
   granted_at, revoked_at, granted_by, max_size_bytes) VALUES
  ('grant-live-party', 'party', 'party-alice', 'core.document', 'doc-1',
   'view', '2025-01-01T00:00:00.000Z', NULL, 'party-owner', 4096),
  ('grant-live-circle', 'circle', 'circle-family', 'docs.folder', 'folder-1',
   'edit', '2025-01-02T00:00:00.000Z', NULL, 'party-owner', NULL),
  ('grant-revoked', 'party', 'party-alice', 'media.asset', 'asset-1',
   'view', '2025-01-03T00:00:00.000Z', '2025-06-01T00:00:00.000Z',
   'party-owner', NULL),
  ('grant-zero-ceiling', 'party', 'party-alice', 'tally.group', 'group-1',
   'edit', '2025-01-04T00:00:00.000Z', NULL, 'party-owner', 0);

INSERT INTO share_fulfillment
  (grant_id, peer_vault_id, state, updated_at, detail, delivered_at) VALUES
  ('grant-live-party', 'vault-alice', 'delivered', '2025-01-05T00:00:00.000Z',
   NULL, '2025-01-05T00:00:00.000Z'),
  ('grant-revoked', 'vault-alice', 'removed', '2025-06-01T00:00:00.000Z',
   'peer confirmed', NULL);

INSERT INTO enrich_consent
  (consent_id, capability, egress, scope_ref, decision, decided_at, receipt_id)
  VALUES
  ('consent-caption', 'caption', 'provider', '', 'granted',
   '2025-02-01T00:00:00.000Z', 'receipt-1'),
  ('consent-ocr', 'ocr', 'gateway', 'media', 'declined',
   '2025-02-02T00:00:00.000Z', NULL);

INSERT INTO consent_device
  (device_id, owner_party_id, name, platform, public_key, trust, enrolled_at,
   last_seen_at, sync_cursor) VALUES
  ('device-laptop', 'party-owner', 'Laptop', 'macos', 'key-laptop', 'full',
   '2025-03-01T00:00:00.000Z', '2025-03-09T00:00:00.000Z', 'cursor-1'),
  ('device-tablet', 'party-owner', 'Tablet', NULL, 'key-tablet', 'readonly',
   '2025-03-02T00:00:00.000Z', NULL, NULL),
  ('device-lost', 'party-owner', 'Lost phone', 'android', 'key-lost',
   'revoked', '2025-03-03T00:00:00.000Z', NULL, NULL);

INSERT INTO blob_device_wrap_key (device_id, salt, key_epoch, updated_at)
  VALUES ('device-laptop', x'00', 1, '2025-03-01T00:00:00.000Z');
`);
}

// node:sqlite hands back null-prototype rows and `toStrictEqual` compares
// prototypes, so every row here is re-shaped as a plain object first.
function plainRows<T>(rows: readonly T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

// Minted device ids are replaced by a stable marker: a random id is not a fact
// the migration promises, everything else about the row is.
function authorityRows(db: DatabaseSync): Record<string, unknown>[] {
  return plainRows(
    db
      .prepare(
        `SELECT CASE WHEN principal_kind = 'device' THEN '<minted>'
                     ELSE authority_id END AS authority_id,
                principal_kind, principal_id, subject_type, subject_id, verb,
                duration, expires_at, decision, granted_at, granted_by,
                revoked_at, receipt_id
           FROM share_authority
          ORDER BY principal_kind, principal_id, subject_type, subject_id, verb`
      )
      .all() as Record<string, unknown>[]
  );
}

function expected(
  overrides: Partial<Record<string, unknown>> & {
    authority_id: string;
    principal_kind: string;
    principal_id: string;
    subject_type: string;
    subject_id: string;
    verb: string;
    decision: string;
    granted_at: string;
  }
): Record<string, unknown> {
  return {
    duration: "standing",
    expires_at: null,
    granted_by: null,
    revoked_at: null,
    receipt_id: null,
    ...overrides,
  };
}

// Every legacy row, and the authority row it must become.
const EXPECTED_ROWS: Record<string, unknown>[] = [
  // circle audiences keep their name; `party` becomes the ruling's `person`.
  expected({
    authority_id: "grant-live-circle",
    principal_kind: "circle",
    principal_id: "circle-family",
    subject_type: "docs.folder",
    subject_id: "folder-1",
    verb: "edit",
    decision: "granted",
    granted_at: "2025-01-02T00:00:00.000Z",
    granted_by: "party-owner",
  }),
  // Three trust levels, three distinct (verb, decision) pairs over core.vault.
  expected({
    authority_id: "<minted>",
    principal_kind: "device",
    principal_id: "device-laptop",
    subject_type: "core.vault",
    subject_id: "",
    verb: "edit",
    decision: "granted",
    granted_at: "2025-03-01T00:00:00.000Z",
    granted_by: "party-owner",
  }),
  // Revoked trust stays a LIVE refusal: cut off must not read as never enrolled.
  expected({
    authority_id: "<minted>",
    principal_kind: "device",
    principal_id: "device-lost",
    subject_type: "core.vault",
    subject_id: "",
    verb: "view",
    decision: "declined",
    granted_at: "2025-03-03T00:00:00.000Z",
    granted_by: "party-owner",
  }),
  expected({
    authority_id: "<minted>",
    principal_kind: "device",
    principal_id: "device-tablet",
    subject_type: "core.vault",
    subject_id: "",
    verb: "view",
    decision: "granted",
    granted_at: "2025-03-02T00:00:00.000Z",
    granted_by: "party-owner",
  }),
  // The scoped decline keeps its scope and its refusal.
  expected({
    authority_id: "consent-ocr",
    principal_kind: "harness",
    principal_id: "gateway",
    subject_type: "enrich.scope",
    subject_id: "media",
    verb: "ocr",
    decision: "declined",
    granted_at: "2025-02-02T00:00:00.000Z",
  }),
  // The vault-wide grant keeps its journal receipt pointer.
  expected({
    authority_id: "consent-caption",
    principal_kind: "harness",
    principal_id: "provider",
    subject_type: "enrich.scope",
    subject_id: "",
    verb: "caption",
    decision: "granted",
    granted_at: "2025-02-01T00:00:00.000Z",
    receipt_id: "receipt-1",
  }),
  expected({
    authority_id: "grant-live-party",
    principal_kind: "person",
    principal_id: "party-alice",
    subject_type: "core.document",
    subject_id: "doc-1",
    verb: "view",
    decision: "granted",
    granted_at: "2025-01-01T00:00:00.000Z",
    granted_by: "party-owner",
  }),
  // A revoked grant is history the plane keeps, dated exactly as it was.
  expected({
    authority_id: "grant-revoked",
    principal_kind: "person",
    principal_id: "party-alice",
    subject_type: "media.asset",
    subject_id: "asset-1",
    verb: "view",
    decision: "granted",
    granted_at: "2025-01-03T00:00:00.000Z",
    granted_by: "party-owner",
    revoked_at: "2025-06-01T00:00:00.000Z",
  }),
  expected({
    authority_id: "grant-zero-ceiling",
    principal_kind: "person",
    principal_id: "party-alice",
    subject_type: "tally.group",
    subject_id: "group-1",
    verb: "edit",
    decision: "granted",
    granted_at: "2025-01-04T00:00:00.000Z",
    granted_by: "party-owner",
  }),
];

describe("schema/migrate rung six (issue #883 one authority plane)", () => {
  test("every row of all three legacy stores lands, losing nothing", () => {
    const db = new DatabaseSync(":memory:");
    seedV5Vault(db);

    migrate(db, RUNGS_THROUGH_SIX);

    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version
    ).toBe(6);
    expect(authorityRows(db)).toStrictEqual(EXPECTED_ROWS);
    db.close();
  });

  test("ceilings move to delivery config, and zero survives as zero", () => {
    const db = new DatabaseSync(":memory:");
    seedV5Vault(db);
    migrate(db, RUNGS_THROUGH_SIX);

    // V-delivery: only a real ceiling gets a row — absence IS the vault-wide
    // default, and `0` is a real ceiling, not a missing one.
    expect(
      plainRows(
        db
          .prepare(
            `SELECT grant_id, max_size_bytes FROM share_delivery_config
              ORDER BY grant_id`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      { grant_id: "grant-live-party", max_size_bytes: 4096 },
      { grant_id: "grant-zero-ceiling", max_size_bytes: 0 },
    ]);
    db.close();
  });

  test("delivery memory keeps pointing at the same grant after the reparent", () => {
    const db = new DatabaseSync(":memory:");
    seedV5Vault(db);
    migrate(db, RUNGS_THROUGH_SIX);

    // The grant id is CARRIED into `authority_id` for exactly this reason: a
    // fulfillment row that lost its parent reads as undelivered (#846).
    expect(
      plainRows(
        db
          .prepare(
            `SELECT f.grant_id AS grant_id, f.state AS state,
                    f.detail AS detail, f.delivered_at AS delivered_at,
                    a.principal_id AS principal
               FROM share_fulfillment f
               JOIN share_authority a ON a.authority_id = f.grant_id
              ORDER BY f.grant_id`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      {
        grant_id: "grant-live-party",
        state: "delivered",
        detail: null,
        delivered_at: "2025-01-05T00:00:00.000Z",
        principal: "party-alice",
      },
      {
        grant_id: "grant-revoked",
        state: "removed",
        detail: "peer confirmed",
        delivered_at: null,
        principal: "party-alice",
      },
    ]);
    db.close();
  });

  test("the superseded storage is gone, and the identity it hung off is intact", () => {
    const db = new DatabaseSync(":memory:");
    seedV5Vault(db);
    migrate(db, RUNGS_THROUGH_SIX);

    for (const dropped of ["share_grant", "enrich_consent"]) {
      expect(
        db
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
          )
          .get(dropped),
        dropped
      ).toBeUndefined();
    }
    const deviceColumns = (
      db.prepare(`PRAGMA table_info(consent_device)`).all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    expect(deviceColumns).not.toContain("trust");
    // Identity survived the rebuild whole, child row included.
    expect(
      plainRows(
        db
          .prepare(
            `SELECT device_id, owner_party_id, name, platform, public_key,
                    enrolled_at, last_seen_at, sync_cursor
               FROM consent_device ORDER BY device_id`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      {
        device_id: "device-laptop",
        owner_party_id: "party-owner",
        name: "Laptop",
        platform: "macos",
        public_key: "key-laptop",
        enrolled_at: "2025-03-01T00:00:00.000Z",
        last_seen_at: "2025-03-09T00:00:00.000Z",
        sync_cursor: "cursor-1",
      },
      {
        device_id: "device-lost",
        owner_party_id: "party-owner",
        name: "Lost phone",
        platform: "android",
        public_key: "key-lost",
        enrolled_at: "2025-03-03T00:00:00.000Z",
        last_seen_at: null,
        sync_cursor: null,
      },
      {
        device_id: "device-tablet",
        owner_party_id: "party-owner",
        name: "Tablet",
        platform: null,
        public_key: "key-tablet",
        enrolled_at: "2025-03-02T00:00:00.000Z",
        last_seen_at: null,
        sync_cursor: null,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM blob_device_wrap_key
            WHERE device_id = 'device-laptop'`
        )
        .get()
    ).toMatchObject({ n: 1 });
    // The rebuilds are honest about their foreign keys, not merely deferred
    // past them: a check now would find nothing broken.
    expect(
      db.prepare(`PRAGMA foreign_key_check`).all() as unknown[]
    ).toStrictEqual([]);
    db.close();
  });

  test("the rung leaves no scaffolding behind and is a no-op on replay", () => {
    const db = new DatabaseSync(":memory:");
    seedV5Vault(db);
    migrate(db, RUNGS_THROUGH_SIX);
    for (const scaffold of ["share_fulfillment_new", "consent_device_new"]) {
      expect(
        db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(scaffold),
        scaffold
      ).toBeUndefined();
    }
    const after = authorityRows(db);
    migrate(db, RUNGS_THROUGH_SIX);
    expect(authorityRows(db)).toStrictEqual(after);
    db.close();
  });

  test("a fresh vault reaches the same shape by walking the rung once", () => {
    const db = openVaultDb();
    // The plane's own indexes are real on a fresh file, not only on the upgrade
    // path — the rung is the ONLY place either path gets them.
    for (const index of [
      "share_authority_live_answer",
      "share_authority_subject",
      "share_authority_principal",
      "share_authority_granted_by",
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
    // Bootstrap has not run, so the only thing a fresh file can hold is nothing.
    expect(
      db.vault.prepare(`SELECT COUNT(*) AS n FROM share_authority`).get()
    ).toMatchObject({ n: 0 });
    db.close();
  });
});
