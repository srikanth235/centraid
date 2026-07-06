import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import { isSealedValue, sealAad, unsealValue } from '../schema/sealed.js';
import type { Credential } from '../gateway/types.js';
import { LOCKER_ITEM_TYPE, registerLockerCommands } from './locker.js';

const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Alex' });
  gw = createGateway(db);
  registerLockerCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}
function out<T = Record<string, unknown>>(o: ReturnType<typeof invoke>): T {
  expect(o.status).toBe('executed');
  return (o as { output: T }).output;
}
function row(itemId: string): Record<string, unknown> | undefined {
  return db.vault.prepare('SELECT * FROM locker_item WHERE item_id = ?').get(itemId) as
    | Record<string, unknown>
    | undefined;
}
/** At-rest secret value, decrypted for assertion (issue #293: rows hold ciphertext). */
function unsealCell(itemId: string, column: string): string | null {
  const r = row(itemId);
  const v = r?.[column];
  if (v == null) return null;
  expect(isSealedValue(v), `${column} should be sealed at rest`).toBe(true);
  return unsealValue(db.sealKey, sealAad('locker_item', column, itemId), String(v));
}
function tagsOf(itemId: string): string[] {
  return (
    db.vault
      .prepare('SELECT tag FROM locker_item_tag WHERE item_id = ? ORDER BY tag')
      .all(itemId) as {
      tag: string;
    }[]
  ).map((r) => r.tag);
}
function starCount(itemId: string): number {
  return (
    db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = ? AND t.target_id = ? AND s.uri = ? AND c.notation = 'starred'`,
      )
      .get(LOCKER_ITEM_TYPE, itemId, FLAGS_SCHEME_URI) as { n: number }
  ).n;
}
function addLogin(input: Record<string, unknown> = {}): string {
  return out<{ item_id: string }>(
    invoke('locker.add_item', {
      type: 'login',
      title: 'GitHub',
      username: 'alex@hey.com',
      password: 'H2$kL9mVq!pR4wZ',
      url: 'https://github.com',
      tags: ['work', 'dev'],
      ...input,
    }),
  ).item_id;
}

test('add_item stores the login with its secret fields (sealed at rest) and tags', () => {
  const id = addLogin();
  const r = row(id)!;
  expect(r.type).toBe('login');
  expect(r.title).toBe('GitHub');
  expect(unsealCell(id, 'password')).toBe('H2$kL9mVq!pR4wZ');
  expect(r.deleted_at).toBeNull();
  expect(tagsOf(id)).toEqual(['dev', 'work']);
});

test('add_item nulls fields that do not belong to the item type', () => {
  const id = out<{ item_id: string }>(
    invoke('locker.add_item', {
      type: 'note',
      title: 'Passport',
      content: 'No. 5123',
      username: 'ignored',
    }),
  ).item_id;
  const r = row(id)!;
  expect(unsealCell(id, 'content')).toBe('No. 5123');
  // username is not a note field, so it is dropped, not smuggled in.
  expect(r.username).toBeNull();
});

test('edit_item rewrites the type fields and replaces tags', () => {
  const id = addLogin();
  out(
    invoke('locker.edit_item', {
      item_id: id,
      title: 'GitHub (work)',
      password: 'newpass123!',
      tags: ['dev'],
    }),
  );
  const r = row(id)!;
  expect(r.title).toBe('GitHub (work)');
  expect(unsealCell(id, 'password')).toBe('newpass123!');
  expect(tagsOf(id)).toEqual(['dev']);
});

test('trash sets a purge date and keeps the star; restore is lossless', () => {
  const id = addLogin();
  out(invoke('locker.star_item', { item_id: id }));
  expect(starCount(id)).toBe(1);
  out(invoke('locker.trash_item', { item_id: id }));
  const t = row(id)!;
  expect(t.deleted_at).not.toBeNull();
  expect(t.purge_at).not.toBeNull();
  expect(starCount(id)).toBe(1); // the star survives the trash
  out(invoke('locker.restore_item', { item_id: id }));
  const rr = row(id)!;
  expect(rr.deleted_at).toBeNull();
  expect(rr.purge_at).toBeNull();
});

test('edit is refused on a trashed item', () => {
  const id = addLogin();
  out(invoke('locker.trash_item', { item_id: id }));
  const o = invoke('locker.edit_item', { item_id: id, title: 'nope' });
  expect(o.status).toBe('failed');
});

test('purge removes the row, its tags and its star for good', () => {
  const id = addLogin();
  out(invoke('locker.star_item', { item_id: id }));
  out(invoke('locker.purge_item', { item_id: id }));
  expect(row(id)).toBeUndefined();
  expect(tagsOf(id)).toEqual([]);
  expect(starCount(id)).toBe(0);
});

test('unstar clears the flag idempotently', () => {
  const id = addLogin();
  out(invoke('locker.star_item', { item_id: id }));
  out(invoke('locker.unstar_item', { item_id: id }));
  out(invoke('locker.unstar_item', { item_id: id }));
  expect(starCount(id)).toBe(0);
});
