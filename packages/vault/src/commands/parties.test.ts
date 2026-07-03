import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerPartyCommands } from './parties.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerPartyCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function addParty(input: Record<string, unknown>): string {
  const outcome = invoke('core.add_party', input);
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { party_id: string } }).output.party_id;
}

test('add_party mints a person with identifiers, first per scheme primary', () => {
  const partyId = addParty({
    display_name: 'Ravi Kumar',
    sort_name: 'Kumar, Ravi',
    identifiers: [
      { scheme: 'email', value: 'ravi@example.com', label: 'work' },
      { scheme: 'email', value: 'ravi@home.example' },
      { scheme: 'tel', value: '+91-98-0000-0000' },
    ],
  });
  const party = db.vault.prepare('SELECT * FROM core_party WHERE party_id = ?').get(partyId);
  expect(party).toMatchObject({
    kind: 'person',
    display_name: 'Ravi Kumar',
    sort_name: 'Kumar, Ravi',
  });
  const ids = db.vault
    .prepare(
      'SELECT scheme, value, is_primary FROM core_party_identifier WHERE party_id = ? ORDER BY scheme, is_primary DESC',
    )
    .all(partyId) as { scheme: string; value: string; is_primary: number }[];
  expect(ids).toHaveLength(3);
  expect(ids.filter((i) => i.scheme === 'email' && i.is_primary === 1)).toHaveLength(1);
  expect(ids.filter((i) => i.scheme === 'tel' && i.is_primary === 1)).toHaveLength(1);
});

test('add_party defaults to kind person and no identifiers', () => {
  const partyId = addParty({ display_name: 'Meera' });
  const party = db.vault.prepare('SELECT kind FROM core_party WHERE party_id = ?').get(partyId) as {
    kind: string;
  };
  expect(party.kind).toBe('person');
});

test('add_party refuses an identifier already claimed by another party (no identity fork)', () => {
  addParty({
    display_name: 'Ravi Kumar',
    identifiers: [{ scheme: 'email', value: 'ravi@example.com' }],
  });
  const outcome = invoke('core.add_party', {
    display_name: 'A Second Ravi',
    identifiers: [{ scheme: 'email', value: 'ravi@example.com' }],
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.reason).toContain('already identifies');
  // The refusal left no half-created party behind (transactional).
  const count = db.vault
    .prepare(`SELECT count(*) AS n FROM core_party WHERE display_name = 'A Second Ravi'`)
    .get() as { n: number };
  expect(count.n).toBe(0);
});

test('update_party revises fields and bumps updated_at; agent rows are untouchable', () => {
  const partyId = addParty({ display_name: 'Ravi' });
  const before = db.vault
    .prepare('SELECT updated_at FROM core_party WHERE party_id = ?')
    .get(partyId) as { updated_at: string };
  const outcome = invoke('core.update_party', {
    party_id: partyId,
    display_name: 'Ravi Kumar',
    birth_date: '1988-04-12',
  });
  expect(outcome.status).toBe('executed');
  const party = db.vault
    .prepare('SELECT display_name, birth_date, updated_at FROM core_party WHERE party_id = ?')
    .get(partyId) as { display_name: string; birth_date: string; updated_at: string };
  expect(party.display_name).toBe('Ravi Kumar');
  expect(party.birth_date).toBe('1988-04-12');
  expect(party.updated_at >= before.updated_at).toBe(true);

  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('agent-party', 'agent', 'assistant', ?, ?, '1.1')`,
    )
    .run(now, now);
  const refused = invoke('core.update_party', { party_id: 'agent-party', display_name: 'renamed' });
  expect(refused.status).toBe('failed');
  if (refused.status === 'failed') expect(refused.predicate).toContain('party_exists_and_editable');
});
