import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerTallyCommands } from './tally.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let me: string;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Alex' });
  gw = createGateway(db);
  registerTallyCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  me = (
    db.vault.prepare('SELECT owner_party_id AS id FROM core_vault LIMIT 1').get() as { id: string }
  ).id;
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}
function out<T = Record<string, unknown>>(o: ReturnType<typeof invoke>): T {
  expect(o.status).toBe('executed');
  return (o as { output: T }).output;
}
function addFriend(name = 'Priya Nair'): string {
  return out<{ party_id: string }>(invoke('tally.add_friend', { name, avatar_color: '#4E68DD' }))
    .party_id;
}
function members(groupId: string): string[] {
  return (
    db.vault
      .prepare('SELECT party_id AS id FROM tally_group_member WHERE group_id = ?')
      .all(groupId) as {
      id: string;
    }[]
  ).map((r) => r.id);
}

test('add_friend mints a canonical person party plus its tally_friend row', () => {
  const pid = addFriend();
  const party = db.vault
    .prepare('SELECT kind, display_name FROM core_party WHERE party_id = ?')
    .get(pid) as {
    kind: string;
    display_name: string;
  };
  expect(party.kind).toBe('person');
  expect(party.display_name).toBe('Priya Nair');
  const f = db.vault
    .prepare('SELECT avatar_color FROM tally_friend WHERE party_id = ?')
    .get(pid) as {
    avatar_color: string;
  };
  expect(f.avatar_color).toBe('#4E68DD');
});

test('create_group always includes the owner as a member', () => {
  const priya = addFriend();
  const gid = out<{ group_id: string }>(
    invoke('tally.create_group', { name: 'Apartment', icon: '🏠', member_ids: [priya] }),
  ).group_id;
  expect(members(gid).sort()).toEqual([me, priya].sort());
});

test('add_expense stores balanced splits and rejects an imbalance', () => {
  const priya = addFriend();
  const gid = out<{ group_id: string }>(
    invoke('tally.create_group', { name: 'Apt', icon: '🏠', member_ids: [priya] }),
  ).group_id;
  const ok = invoke('tally.add_expense', {
    group_id: gid,
    description: 'Rent',
    amount_minor: 2400,
    paid_by: me,
    category: 'rent',
    splits: [
      { party_id: me, share_minor: 1200 },
      { party_id: priya, share_minor: 1200 },
    ],
  });
  expect(ok.status).toBe('executed');

  const bad = invoke('tally.add_expense', {
    group_id: gid,
    description: 'Groceries',
    amount_minor: 1000,
    paid_by: me,
    category: 'groceries',
    splits: [
      { party_id: me, share_minor: 400 },
      { party_id: priya, share_minor: 400 },
    ],
  });
  expect(bad.status).toBe('failed'); // 800 ≠ 1000
});

test('add_expense refuses a payer or participant outside the group', () => {
  const priya = addFriend();
  const sam = addFriend('Sam Okafor');
  const gid = out<{ group_id: string }>(
    invoke('tally.create_group', { name: 'Apt', icon: '🏠', member_ids: [priya] }),
  ).group_id;
  const o = invoke('tally.add_expense', {
    group_id: gid,
    description: 'Dinner',
    amount_minor: 500,
    paid_by: sam, // not a member
    category: 'food',
    splits: [{ party_id: sam, share_minor: 500 }],
  });
  expect(o.status).toBe('failed');
});

test('settle_up records a payment and refuses a self-settlement', () => {
  const priya = addFriend();
  const ok = invoke('tally.settle_up', { from_party: priya, to_party: me, amount_minor: 300 });
  expect(ok.status).toBe('executed');
  const self = invoke('tally.settle_up', { from_party: me, to_party: me, amount_minor: 100 });
  expect(self.status).toBe('failed');
});

test('delete_group is refused while it holds an expense, allowed once empty', () => {
  const priya = addFriend();
  const gid = out<{ group_id: string }>(
    invoke('tally.create_group', { name: 'Apt', icon: '🏠', member_ids: [priya] }),
  ).group_id;
  const xid = out<{ expense_id: string }>(
    invoke('tally.add_expense', {
      group_id: gid,
      description: 'Rent',
      amount_minor: 200,
      paid_by: me,
      category: 'rent',
      splits: [
        { party_id: me, share_minor: 100 },
        { party_id: priya, share_minor: 100 },
      ],
    }),
  ).expense_id;
  expect(invoke('tally.delete_group', { group_id: gid }).status).toBe('failed');
  out(invoke('tally.delete_expense', { expense_id: xid }));
  expect(invoke('tally.delete_group', { group_id: gid }).status).toBe('executed');
});

test('remove_group_member is refused while the member is on the ledger', () => {
  const priya = addFriend();
  const gid = out<{ group_id: string }>(
    invoke('tally.create_group', { name: 'Apt', icon: '🏠', member_ids: [priya] }),
  ).group_id;
  out(
    invoke('tally.add_expense', {
      group_id: gid,
      description: 'Rent',
      amount_minor: 200,
      paid_by: me,
      category: 'rent',
      splits: [
        { party_id: me, share_minor: 100 },
        { party_id: priya, share_minor: 100 },
      ],
    }),
  );
  expect(invoke('tally.remove_group_member', { group_id: gid, party_id: priya }).status).toBe(
    'failed',
  );
});
