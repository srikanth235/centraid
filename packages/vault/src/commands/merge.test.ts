// core.merge_party (issue #290 phase 2): folding a duplicate person re-points
// every reference — engine FKs, polymorphic (type, id) pairs, identifiers
// with primary demotion, the external-id map — and deletes the duplicate.

import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import { registerPartyCommands } from './parties.js';
import { registerPeopleCommands } from './people.js';
import type { Credential, InvokeOutcome } from '../gateway/types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerPartyCommands(gw);
  registerPeopleCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function addParty(name: string, email?: string): string {
  const outcome = gw.invoke(owner, {
    command: 'core.add_party',
    input: {
      display_name: name,
      ...(email ? { identifiers: [{ scheme: 'email', value: email }] } : {}),
    },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { party_id: string } }).output.party_id;
}

function merge(survivor: string, merged: string): InvokeOutcome {
  return gw.invoke(owner, {
    command: 'core.merge_party',
    input: { survivor_party_id: survivor, merged_party_id: merged },
    purpose: 'dpv:ServiceProvision',
  });
}

test('merge re-points identifiers (primary demoted), FK rows and the map; duplicate gone', () => {
  const john = addParty('John Smith', 'john@work.example');
  const dupe = addParty('J. Smith', 'jsmith@personal.example');
  // A canonical task hanging off the duplicate (engine FK).
  db.vault
    .prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority)
       VALUES ('task-1', ?, 'quarterly catch-up', 'needs-action', 0)`,
    )
    .run(dupe);
  // A mapped external id pointing at the duplicate.
  db.vault
    .prepare(
      `INSERT INTO sync_connection (connection_id, kind, label, principal, status, trust, created_at)
       VALUES ('c1', 'file.vcf', 'contacts.vcf', NULL, 'active', 'staged', '2026-07-06T00:00:00Z')`,
    )
    .run();
  db.vault
    .prepare(
      `INSERT INTO sync_external_entity (map_id, connection_id, external_id, target_type, target_id, content_hash, first_seen_at, last_seen_at, gone_upstream)
       VALUES ('m1', 'c1', 'email:jsmith@personal.example', 'core.party', ?, 'h', '2026-07-06', '2026-07-06', 0)`,
    )
    .run(dupe);

  const outcome = merge(john, dupe);
  expect(outcome.status).toBe('executed');
  const output = (outcome as { output: { repointed: number } }).output;
  expect(output.repointed).toBeGreaterThanOrEqual(3); // identifier + task + map

  // Duplicate gone; references live on the survivor.
  expect(
    db.vault.prepare('SELECT 1 AS x FROM core_party WHERE party_id = ?').get(dupe),
  ).toBeUndefined();
  const ids = db.vault
    .prepare(
      'SELECT value, is_primary FROM core_party_identifier WHERE party_id = ? ORDER BY value',
    )
    .all(john);
  expect(ids).toEqual([
    { value: 'john@work.example', is_primary: 1 },
    { value: 'jsmith@personal.example', is_primary: 0 }, // demoted, never lost
  ]);
  const moved = db.vault
    .prepare('SELECT count(*) AS n FROM schedule_task WHERE owner_party_id = ?')
    .get(john) as { n: number };
  expect(moved.n).toBe(1);
  const map = db.vault
    .prepare('SELECT target_id FROM sync_external_entity WHERE map_id = ?')
    .get('m1') as { target_id: string };
  expect(map.target_id).toBe(john);
});

test('merging the vault owner away is refused by contract', () => {
  const other = addParty('Someone Else');
  const outcome = merge(other, boot.ownerPartyId);
  expect(outcome.status).toBe('failed');
  expect((outcome as { reason: string }).reason).toMatch(/merged_is_not_the_owner/);
});

test('self-merge is refused by contract', () => {
  const p = addParty('Solo');
  const outcome = merge(p, p);
  expect(outcome.status).toBe('failed');
});

// ── The convergence sweep (issue #310 C4) ──────────────────────────────

test('find_duplicate_parties reports name collisions with identifier context', () => {
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('dup-a', 'person', 'J. Smith', ?, ?, '1.1'), ('dup-b', 'person', 'j. smith', ?, ?, '1.1'),
              ('solo', 'person', 'Unique Name', ?, ?, '1.1')`,
    )
    .run(now, now, now, now, now, now);
  db.vault
    .prepare(
      `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, is_primary, valid_from)
       VALUES ('di-1', 'dup-a', 'email', 'js@work.example', 1, ?), ('di-2', 'dup-b', 'tel', '+15550001', 1, ?)`,
    )
    .run(now, now);
  const outcome = gw.invoke(owner, {
    command: 'core.find_duplicate_parties',
    input: {},
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  if (outcome.status !== 'executed') return;
  const candidates = (outcome.output as { candidates: Record<string, unknown>[] }).candidates;
  const pair = candidates.find((c) => c.party_a === 'dup-a' && c.party_b === 'dup-b');
  expect(pair).toBeDefined();
  expect(String(pair?.a_identifiers)).toContain('email:js@work.example');
  expect(String(pair?.b_identifiers)).toContain('tel:+15550001');
  expect(candidates.some((c) => c.party_a === 'solo' || c.party_b === 'solo')).toBe(false);
});
