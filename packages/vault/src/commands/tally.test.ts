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
  return out<{ party_id: string }>(invoke('tally.add_friend', { name })).party_id;
}
function members(groupId: string): string[] {
  // Membership lives on the group's circle (issue #310 S4).
  return (
    db.vault
      .prepare(
        `SELECT m.party_id AS id FROM social_circle_member m
           JOIN tally_group g ON g.circle_id = m.circle_id
          WHERE g.group_id = ?`,
      )
      .all(groupId) as { id: string }[]
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
  const f = db.vault.prepare('SELECT friend_id FROM tally_friend WHERE party_id = ?').get(pid) as {
    friend_id: string;
  };
  expect(f.friend_id).toBeTruthy();
});

test('avatar_color is stored exactly once per party — on people_profile, never on tally_friend (issue #441 A3)', () => {
  // The same party is both a Tally friend and a People CRM contact; give it a
  // people_profile carrying a hue (the one surviving home for a stored hue).
  const pid = addFriend('Dual Party');
  db.vault
    .prepare(
      `INSERT INTO people_profile (profile_id, party_id, role, avatar_color, cadence_days, last_contacted_at, met, created_at)
       VALUES (?, ?, NULL, '#7C5BD9', 30, NULL, NULL, ?)`,
    )
    .run('profile-dual', pid, new Date().toISOString());

  // tally_friend has no hue column at all — the consolidation dropped it.
  const tallyCols = (
    db.vault.prepare("PRAGMA table_info('tally_friend')").all() as { name: string }[]
  ).map((c) => c.name);
  expect(tallyCols).not.toContain('avatar_color');

  // people_profile is the single home for a stored hue.
  const profileCols = (
    db.vault.prepare("PRAGMA table_info('people_profile')").all() as { name: string }[]
  ).map((c) => c.name);
  expect(profileCols).toContain('avatar_color');

  // Exactly one stored hue exists for this party across the two 1:1 tables.
  const hues = db.vault
    .prepare(
      'SELECT avatar_color FROM people_profile WHERE party_id = ? AND avatar_color IS NOT NULL',
    )
    .all(pid) as { avatar_color: string }[];
  expect(hues).toHaveLength(1);
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

function addRentExpense(gid: string, priya: string): string {
  return out<{ expense_id: string }>(
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
}

test('delete_group is refused while it holds an expense — a TRASHED expense still blocks until it purges', () => {
  const priya = addFriend();
  const gid = out<{ group_id: string }>(
    invoke('tally.create_group', { name: 'Apt', icon: '🏠', member_ids: [priya] }),
  ).group_id;
  const xid = addRentExpense(gid, priya);
  // A live expense refuses the group deletion.
  expect(invoke('tally.delete_group', { group_id: gid }).status).toBe('failed');
  // delete_expense now soft-deletes (issue #441 A4). The decision: a TRASHED
  // (recoverable) expense STILL blocks group deletion until it purges — it is
  // money history the owner could restore, so the group cannot be torn out from
  // under it.
  out(invoke('tally.delete_expense', { expense_id: xid }));
  expect(invoke('tally.delete_group', { group_id: gid }).status).toBe('failed');
  // Restore proves it round-trips losslessly, then re-trash + purge it.
  out(invoke('tally.restore_expense', { expense_id: xid }));
  out(invoke('tally.delete_expense', { expense_id: xid }));
  db.vault
    .prepare('UPDATE tally_expense SET purge_at = ? WHERE expense_id = ?')
    .run('2000-01-01T00:00:00Z', xid);
  gw.sweep(owner);
  // Purged: the row and its splits (ON DELETE CASCADE) are gone.
  expect(
    (
      db.vault.prepare('SELECT count(*) AS n FROM tally_expense WHERE expense_id = ?').get(xid) as {
        n: number;
      }
    ).n,
  ).toBe(0);
  expect(
    (
      db.vault
        .prepare('SELECT count(*) AS n FROM tally_expense_split WHERE expense_id = ?')
        .get(xid) as { n: number }
    ).n,
  ).toBe(0);
  // Now the group is genuinely empty and deletes.
  expect(invoke('tally.delete_group', { group_id: gid }).status).toBe('executed');
});

test('purging a trashed expense via the sweep cleans its polymorphic refs (issue #441 A4/A1)', () => {
  const priya = addFriend();
  const gid = out<{ group_id: string }>(
    invoke('tally.create_group', { name: 'Trip', icon: '✈️', member_ids: [priya] }),
  ).group_id;
  const xid = addRentExpense(gid, priya);
  // A memo is a knowledge_annotation targeting the canonical 'tally.expense' row.
  out(invoke('tally.set_expense_memo', { expense_id: xid, note: 'reimburse later' }));
  const memoCount = () =>
    (
      db.vault
        .prepare(
          `SELECT count(*) AS n FROM knowledge_annotation WHERE target_type = 'tally.expense' AND target_id = ?`,
        )
        .get(xid) as { n: number }
    ).n;
  expect(memoCount()).toBe(1);
  // Trash, lapse the grace window, sweep.
  out(invoke('tally.delete_expense', { expense_id: xid }));
  db.vault
    .prepare('UPDATE tally_expense SET purge_at = ? WHERE expense_id = ?')
    .run('2000-01-01T00:00:00Z', xid);
  gw.sweep(owner);
  // The expense purged, and its memo annotation went with it — no dangling
  // polymorphic pointer (previously leaked on the old hard-delete path).
  expect(
    (
      db.vault.prepare('SELECT count(*) AS n FROM tally_expense WHERE expense_id = ?').get(xid) as {
        n: number;
      }
    ).n,
  ).toBe(0);
  expect(memoCount()).toBe(0);
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
  const e = db.vault.prepare('SELECT txn_id FROM tally_expense WHERE expense_id = ?').get(xid) as {
    txn_id: string | null;
  };
  expect(e.txn_id).toBe('txn1');

  expect(invoke('tally.bind_txn', { txn_id: 'txn1' }).status).toBe('failed'); // no target
  expect(
    invoke('tally.bind_txn', { txn_id: 'txn1', expense_id: xid, settlement_id: 'nope' }).status,
  ).toBe('failed'); // two targets
  expect(invoke('tally.bind_txn', { txn_id: 'missing', expense_id: xid }).status).toBe('failed'); // txn precondition
});

// ── Groups decorate circles (issue #310 S4) ────────────────────────────

test('a group is a social.circle decoration: name and members on the circle', () => {
  const priya = addFriend();
  const gid = out<{ group_id: string }>(
    invoke('tally.create_group', { name: 'Goa Trip', icon: '🌴', member_ids: [priya] }),
  ).group_id;
  const g = db.vault
    .prepare(
      `SELECT c.name, c.kind, c.owner_party_id FROM tally_group tg
         JOIN social_circle c ON c.circle_id = tg.circle_id
        WHERE tg.group_id = ?`,
    )
    .get(gid) as { name: string; kind: string; owner_party_id: string };
  expect(g.name).toBe('Goa Trip');
  expect(g.kind).toBe('custom');
  expect(g.owner_party_id).toBe(me);

  // Rename lands on the circle; a clashing circle name refuses creation.
  out(invoke('tally.rename_group', { group_id: gid, name: 'Goa 2026' }));
  const renamed = db.vault
    .prepare(
      `SELECT c.name FROM tally_group tg JOIN social_circle c ON c.circle_id = tg.circle_id
        WHERE tg.group_id = ?`,
    )
    .get(gid) as { name: string };
  expect(renamed.name).toBe('Goa 2026');
  expect(
    invoke('tally.create_group', { name: 'Goa 2026', icon: '🌴', member_ids: [] }).status,
  ).toBe('failed');
});

test('delete_group removes its circle and membership with it', () => {
  const priya = addFriend();
  const gid = out<{ group_id: string }>(
    invoke('tally.create_group', { name: 'Temp', icon: '📦', member_ids: [priya] }),
  ).group_id;
  const circle = db.vault
    .prepare('SELECT circle_id FROM tally_group WHERE group_id = ?')
    .get(gid) as { circle_id: string };
  out(invoke('tally.delete_group', { group_id: gid }));
  const circles = db.vault
    .prepare('SELECT count(*) AS n FROM social_circle WHERE circle_id = ?')
    .get(circle.circle_id) as { n: number };
  const membersLeft = db.vault
    .prepare('SELECT count(*) AS n FROM social_circle_member WHERE circle_id = ?')
    .get(circle.circle_id) as { n: number };
  expect(circles.n).toBe(0);
  expect(membersLeft.n).toBe(0);
});

test('set_expense_memo writes the canonical annotation; empty note clears it (#310 C6)', () => {
  const priya = addFriend();
  const gid = out<{ group_id: string }>(
    invoke('tally.create_group', { name: 'Apt2', icon: '🏠', member_ids: [priya] }),
  ).group_id;
  const xid = out<{ expense_id: string }>(
    invoke('tally.add_expense', {
      group_id: gid,
      description: 'Dinner at Olive',
      amount_minor: 400,
      paid_by: me,
      category: 'food',
      splits: [
        { party_id: me, share_minor: 200 },
        { party_id: priya, share_minor: 200 },
      ],
    }),
  ).expense_id;
  out(invoke('tally.set_expense_memo', { expense_id: xid, note: 'Landlord still owes us' }));
  const memo = db.vault
    .prepare(
      `SELECT body_text FROM knowledge_annotation WHERE target_type = 'tally.expense' AND target_id = ?`,
    )
    .get(xid) as { body_text: string } | undefined;
  expect(memo?.body_text).toBe('Landlord still owes us');
  out(invoke('tally.set_expense_memo', { expense_id: xid, note: '' }));
  const gone = db.vault
    .prepare(
      `SELECT count(*) AS n FROM knowledge_annotation WHERE target_type = 'tally.expense' AND target_id = ?`,
    )
    .get(xid) as { n: number };
  expect(gone.n).toBe(0);

  // The expense description is searchable (issue #310 C6).
  const hit = db.vault
    .prepare(`SELECT expense_id FROM fts_tally_expense WHERE fts_tally_expense MATCH 'olive'`)
    .get() as { expense_id: string } | undefined;
  expect(hit?.expense_id).toBe(xid);
});
