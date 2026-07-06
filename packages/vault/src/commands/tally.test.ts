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

// ── The finance bridge (issue #310 S1) ─────────────────────────────────

test('settle_up involving the owner emits a canonical transaction and binds it', () => {
  const priya = addFriend();
  const sid = out<{ settlement_id: string; txn_id: string | null }>(
    invoke('tally.settle_up', { from_party: me, to_party: priya, amount_minor: 750 }),
  );
  expect(sid.txn_id).toBeTruthy();
  const s = db.vault
    .prepare('SELECT txn_id FROM tally_settlement WHERE settlement_id = ?')
    .get(sid.settlement_id) as { txn_id: string | null };
  expect(s.txn_id).toBe(sid.txn_id);
  const txn = db.vault
    .prepare(
      `SELECT t.amount_minor, t.direction, t.counterparty_party_id, t.external_id, a.name, a.kind
         FROM core_transaction t JOIN core_account a ON a.account_id = t.account_id
        WHERE t.txn_id = ?`,
    )
    .get(sid.txn_id) as {
    amount_minor: number;
    direction: string;
    counterparty_party_id: string;
    external_id: string;
    name: string;
    kind: string;
  };
  expect(txn.amount_minor).toBe(750);
  expect(txn.direction).toBe('debit'); // owner paid — money left the pool
  expect(txn.counterparty_party_id).toBe(priya);
  expect(txn.external_id).toBe(`tally:settlement:${sid.settlement_id}`);
  expect(txn.name).toBe('Tally settlements');
  expect(txn.kind).toBe('cash');
});

test('settle_up toward the owner posts a credit; friend-to-friend stays tally-only', () => {
  const priya = addFriend();
  const sam = addFriend('Sam Okafor');
  const incoming = out<{ settlement_id: string; txn_id: string | null }>(
    invoke('tally.settle_up', { from_party: priya, to_party: me, amount_minor: 300 }),
  );
  expect(incoming.txn_id).toBeTruthy();
  const dir = db.vault
    .prepare('SELECT direction FROM core_transaction WHERE txn_id = ?')
    .get(incoming.txn_id) as { direction: string };
  expect(dir.direction).toBe('credit');

  const thirdParty = out<{ settlement_id: string; txn_id: string | null }>(
    invoke('tally.settle_up', { from_party: priya, to_party: sam, amount_minor: 200 }),
  );
  expect(thirdParty.txn_id).toBeNull();
  const count = db.vault
    .prepare(`SELECT count(*) AS n FROM core_transaction WHERE external_id LIKE 'tally:%'`)
    .get() as { n: number };
  expect(count.n).toBe(1); // only the owner's settlement reached the ledger
});

test('bind_txn adopts an imported transaction onto an expense, and validates its target', () => {
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
  // An "imported" canonical transaction, as a bank sync would land it.
  db.vault
    .prepare(
      `INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, is_asset)
       VALUES ('acct1', ?, 'HDFC', 'depository', 'USD', 1)`,
    )
    .run(me);
  db.vault
    .prepare(
      `INSERT INTO core_transaction (txn_id, account_id, posted_at, amount_minor, currency, direction, status, external_id)
       VALUES ('txn1', 'acct1', '2026-07-01T00:00:00Z', 200, 'USD', 'debit', 'posted', 'ofx:1')`,
    )
    .run();
  out(invoke('tally.bind_txn', { expense_id: xid, txn_id: 'txn1' }));
  const e = db.vault
    .prepare('SELECT txn_id FROM tally_expense WHERE expense_id = ?')
    .get(xid) as { txn_id: string | null };
  expect(e.txn_id).toBe('txn1');

  expect(invoke('tally.bind_txn', { txn_id: 'txn1' }).status).toBe('failed'); // no target
  expect(
    invoke('tally.bind_txn', { txn_id: 'txn1', expense_id: xid, settlement_id: 'nope' }).status,
  ).toBe('failed'); // two targets
  expect(invoke('tally.bind_txn', { txn_id: 'missing', expense_id: xid }).status).toBe('failed'); // txn precondition
});
