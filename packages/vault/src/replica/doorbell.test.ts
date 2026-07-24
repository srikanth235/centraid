import { afterEach, expect, test, vi } from 'vitest';
import { openVaultDb, type VaultDb } from '../db.js';
import { notifyReplicaCommit, subscribeReplicaCommits } from './doorbell.js';

let db: VaultDb | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function open(): VaultDb {
  db = openVaultDb();
  return db;
}

test('notifyReplicaCommit is a no-op when nobody is subscribed', () => {
  const { vault } = open();
  expect(() => notifyReplicaCommit(vault)).not.toThrow();
});

test('subscribeReplicaCommits delivers notifies and unsubscribe stops delivery', () => {
  const { vault } = open();
  const hits: number[] = [];
  const unsub = subscribeReplicaCommits(vault, () => {
    hits.push(hits.length + 1);
  });

  notifyReplicaCommit(vault);
  notifyReplicaCommit(vault);
  expect(hits).toEqual([1, 2]);

  unsub();
  notifyReplicaCommit(vault);
  expect(hits).toEqual([1, 2]);

  // Idempotent unsubscribe.
  unsub();
  notifyReplicaCommit(vault);
  expect(hits).toEqual([1, 2]);
});

test('a throwing listener does not prevent other listeners or fail the notify', () => {
  const { vault } = open();
  const good = vi.fn();
  const unsubThrow = subscribeReplicaCommits(vault, () => {
    throw new Error('stream closed');
  });
  const unsubGood = subscribeReplicaCommits(vault, good);

  expect(() => notifyReplicaCommit(vault)).not.toThrow();
  expect(good).toHaveBeenCalledTimes(1);

  unsubThrow();
  unsubGood();
});

test('last unsubscribe clears the weakmap entry so a new subscribe starts fresh', () => {
  const { vault } = open();
  const first = vi.fn();
  const unsub = subscribeReplicaCommits(vault, first);
  unsub();

  const second = vi.fn();
  const unsub2 = subscribeReplicaCommits(vault, second);
  notifyReplicaCommit(vault);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
  unsub2();
});
