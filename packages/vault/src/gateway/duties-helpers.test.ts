// Direct unit coverage for standing-duty helpers (issue #545 B2).
// Imports `duties.ts` by name — admitImportedRow / resolveHandle / revoke /
// sweepLifecycle pure-ish paths with a bootstrapped vault.

import { afterEach, beforeEach, expect, test } from 'vitest';
import { bootstrapVault, createGrant, enrollApp, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { uuidv7 } from '../ids.js';
import { admitImportedRow, resolveHandle, revokeGrantCascade, sweepLifecycle } from './duties.js';
import type { Identity } from './types.js';

let db: VaultDb;
let boot: BootstrapResult;
let owner: Identity;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  owner = {
    kind: 'owner-device',
    callerId: boot.deviceId,
    provAgentKind: 'owner',
    partyId: boot.ownerPartyId,
    mayAct: true,
  };
});

afterEach(() => {
  db.close();
});

test('admitImportedRow inserts once and dedupes on the external id column', () => {
  const now = new Date().toISOString();
  // core_event carries ical_uid as its import external id.
  let inserts = 0;
  const first = admitImportedRow(
    db,
    owner,
    'core.event',
    { physical: 'core_event', column: 'ical_uid' },
    'evt-1@example.com',
    () => {
      inserts += 1;
      const id = uuidv7();
      db.vault
        .prepare(
          `INSERT INTO core_event
             (event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule, status, sequence, created_at, updated_at)
           VALUES (?, 'evt-1@example.com', 'Meet', NULL, ?, NULL, NULL, NULL, 'confirmed', 0, ?, ?)`,
        )
        .run(id, now, now, now);
      return id;
    },
    'ics',
  );
  expect(first).toBeTruthy();
  expect(inserts).toBe(1);
  const second = admitImportedRow(
    db,
    owner,
    'core.event',
    { physical: 'core_event', column: 'ical_uid' },
    'evt-1@example.com',
    () => {
      inserts += 1;
      return uuidv7();
    },
    'ics',
  );
  expect(second).toBeNull();
  expect(inserts).toBe(1);
  const prov = db.journal
    .prepare(
      `SELECT count(*) AS n FROM consent_provenance
        WHERE entity_type = 'core.event' AND prov_activity = 'import.ics'`,
    )
    .get() as { n: number };
  expect(prov.n).toBe(1);
});

test('resolveHandle finds a live primary email and ignores expired ones', () => {
  const now = new Date().toISOString();
  const past = '2020-01-01T00:00:00.000Z';
  db.vault
    .prepare(
      `INSERT INTO core_party_identifier
         (identifier_id, party_id, scheme, value, label, is_primary, valid_from, valid_to)
       VALUES (?, ?, 'email', 'priya@example.com', 'home', 1, ?, NULL)`,
    )
    .run(uuidv7(), boot.ownerPartyId, now);
  expect(resolveHandle(db, 'email', 'priya@example.com')).toBe(boot.ownerPartyId);

  const other = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES (?, 'person', 'Expired', ?, ?, '1.4')`,
    )
    .run(other, now, now);
  db.vault
    .prepare(
      `INSERT INTO core_party_identifier
         (identifier_id, party_id, scheme, value, label, is_primary, valid_from, valid_to)
       VALUES (?, ?, 'email', 'gone@example.com', NULL, 1, ?, ?)`,
    )
    .run(uuidv7(), other, past, past);
  expect(resolveHandle(db, 'email', 'gone@example.com')).toBeNull();
  expect(resolveHandle(db, 'tel', '+10000000000')).toBeNull();
});

test('revokeGrantCascade marks the grant revoked and drops parked via callback', () => {
  const app = enrollApp(db, { name: 'duty-app' });
  const grantId = createGrant(db, {
    appId: app.appId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'schedule', verbs: 'read' }],
  });
  let dropped = 0;
  const result = revokeGrantCascade(db, owner, grantId, () => {
    dropped = 3;
    return 3;
  });
  expect(result).toMatchObject({
    grantId,
    appId: 'duty-app',
    viewsRevoked: 0,
    parkedDropped: 3,
  });
  expect(dropped).toBe(3);
  const grant = db.vault
    .prepare('SELECT status, revoked_at FROM consent_access_grant WHERE grant_id = ?')
    .get(grantId) as { status: string; revoked_at: string | null };
  expect(grant.status).toBe('revoked');
  expect(grant.revoked_at).toBeTruthy();
  expect(() => revokeGrantCascade(db, owner, 'missing-grant', () => 0)).toThrow(/no grant/);
});

test('sweepLifecycle returns a zeroed result shape on a clean vault', () => {
  const result = sweepLifecycle(db, owner);
  expect(result).toMatchObject({
    grantsExpired: 0,
    sharesExpired: 0,
    contentPurged: 0,
    assetsPurged: 0,
    notesPurged: 0,
    documentsPurged: 0,
    domainRowsPurged: 0,
    retentionDeleted: 0,
    blobsReclaimed: 0,
  });
  expect(result.receiptId.length).toBeGreaterThan(10);
});
