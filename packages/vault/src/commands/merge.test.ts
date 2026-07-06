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
  // A people-domain row hanging off the duplicate (engine FK).
  db.vault
    .prepare(
      `INSERT INTO people_interaction (interaction_id, party_id, kind, body_text, occurred_at, created_at)
       VALUES ('i1', ?, 'call', 'quarterly catch-up', '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z')`,
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
      `INSERT INTO sync_external_entity (map_id, connection_id, external_id, entity_type, entity_id, content_hash, first_seen_at, last_seen_at, gone_upstream)
       VALUES ('m1', 'c1', 'email:jsmith@personal.example', 'core.party', ?, 'h', '2026-07-06', '2026-07-06', 0)`,
    )
    .run(dupe);

  const outcome = merge(john, dupe);
  expect(outcome.status).toBe('executed');
  const output = (outcome as { output: { repointed: number } }).output;
  expect(output.repointed).toBeGreaterThanOrEqual(3); // identifier + interaction + map

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
    .prepare('SELECT count(*) AS n FROM people_interaction WHERE party_id = ?')
    .get(john) as { n: number };
  expect(moved.n).toBe(1);
  const map = db.vault
    .prepare('SELECT entity_id FROM sync_external_entity WHERE map_id = ?')
    .get('m1') as { entity_id: string };
  expect(map.entity_id).toBe(john);
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
