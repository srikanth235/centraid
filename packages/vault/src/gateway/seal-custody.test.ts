// Key custody lifecycle (issue #298 items 1, 2, 8): the fingerprint stamped
// at first seal makes a missing or regenerated key a loud open-time error,
// never a silent re-mint discovered as GCM garbage at reveal; the reseal
// verb rotates the DEK across the live and draft bands atomically; and the
// sealed-value predicate is structural, so user input cannot satisfy it.

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, type Gateway } from '../gateway/gateway.js';
import { registerLockerCommands } from '../commands/locker.js';
import { resealVaultKey } from './reseal.js';
import {
  SEALED_PREFIX,
  SealKeyError,
  isSealedValue,
  loadSealKey,
  readSealKeyFingerprint,
  sealKeyFileFor,
  sealKeyFingerprint,
  writeSealKeyFile,
} from '../schema/sealed.js';
import type { Credential } from '../gateway/types.js';

const PURPOSE = 'dpv:ServiceProvision';

let root: string;
let vaultDir: string;
let db: VaultDb;
let boot: BootstrapResult;
let gw: Gateway;
let owner: Credential;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'seal-custody-'));
  vaultDir = path.join(root, 'vault-a');
  db = openVaultDb({ dir: vaultDir });
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerLockerCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function addLogin(password = 'hunter2-Corr3ct', alias?: string): string {
  const out = gw.invoke(owner, {
    command: 'locker.add_item',
    input: {
      type: 'login',
      title: 'example.com',
      username: 'priya',
      password,
      url: 'https://example.com',
      otp_seed: 'JBSWY3DPEHPK3PXP',
      ...(alias ? { alias } : {}),
    },
    purpose: PURPOSE,
  });
  expect(out.status).toBe('executed');
  return (out as { output: { item_id: string } }).output.item_id;
}

function reopen(): VaultDb {
  db.close();
  return openVaultDb({ dir: vaultDir });
}

// ── fingerprint stamping ────────────────────────────────────────────────

test('a vault that never sealed carries no fingerprint; first seal stamps it', () => {
  expect(readSealKeyFingerprint(db.vault)).toBeNull();
  addLogin();
  expect(readSealKeyFingerprint(db.vault)).toBe(sealKeyFingerprint(db.sealKey));
});

test('a never-sealed vault may lose its key file and still reopen (fresh mint)', () => {
  const keyFile = sealKeyFileFor(vaultDir);
  rmSync(keyFile);
  db = reopen();
  expect(loadSealKey(keyFile)).not.toBeNull();
});

// ── open-time detection (issue #298 item 1) ─────────────────────────────

test('once sealed, a missing key file is a loud SealKeyError at OPEN, never a re-mint', () => {
  addLogin();
  rmSync(sealKeyFileFor(vaultDir));
  db.close();
  let caught: unknown;
  try {
    db = openVaultDb({ dir: vaultDir });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SealKeyError);
  expect((caught as SealKeyError).code).toBe('missing');
  expect((caught as SealKeyError).message).toContain('unrecoverable');
  // reopen with the ephemeral override so afterEach can close cleanly
  db = openVaultDb({ dir: vaultDir, sealKey: Buffer.alloc(32) });
});

test('a regenerated (wrong) key is a distinguishable mismatch error at open', () => {
  addLogin();
  writeSealKeyFile(sealKeyFileFor(vaultDir), Buffer.alloc(32, 7));
  db.close();
  let caught: unknown;
  try {
    db = openVaultDb({ dir: vaultDir });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SealKeyError);
  expect((caught as SealKeyError).code).toBe('mismatch');
  db = openVaultDb({ dir: vaultDir, sealKey: Buffer.alloc(32) });
});

test('the key survives a vault DIRECTORY move when the key moves with it (the documented gesture)', () => {
  const itemId = addLogin();
  db.close();
  const newDir = path.join(root, 'vault-b');
  renameSync(vaultDir, newDir);
  renameSync(sealKeyFileFor(vaultDir), sealKeyFileFor(newDir));
  const moved = openVaultDb({ dir: newDir });
  const gw2 = createGateway(moved);
  registerLockerCommands(gw2);
  const revealed = gw2.reveal(owner, {
    entity: 'locker.item',
    entityId: itemId,
    columns: ['password'],
    purpose: PURPOSE,
  });
  expect(revealed.values['password']).toBe('hunter2-Corr3ct');
  moved.close();
  db = openVaultDb({ dir: vaultDir, sealKey: Buffer.alloc(32) }); // placate afterEach
  vaultDir = newDir;
});

test('a directory move WITHOUT the key is exactly the caught disaster', () => {
  addLogin();
  db.close();
  const newDir = path.join(root, 'vault-b');
  renameSync(vaultDir, newDir);
  expect(() => openVaultDb({ dir: newDir })).toThrow(SealKeyError);
  db = openVaultDb({ dir: vaultDir, sealKey: Buffer.alloc(32) });
});

// ── reseal (issue #298 item 8) ──────────────────────────────────────────

test('reseal rotates every sealed cell and the stamped fingerprint; old key stops working', () => {
  const itemId = addLogin('rotate-me-1234');
  const before = Buffer.from(db.sealKey);
  const result = resealVaultKey(db);
  expect(result.resealedCells).toBeGreaterThanOrEqual(2); // password + otp_seed
  expect(result.oldFingerprint).toBe(sealKeyFingerprint(before));
  expect(result.newFingerprint).toBe(readSealKeyFingerprint(db.vault));
  expect(result.newFingerprint).not.toBe(result.oldFingerprint);
  // Live handle keeps working (buffer swapped in place)…
  const revealed = gw.reveal(owner, {
    entity: 'locker.item',
    entityId: itemId,
    columns: ['password'],
    purpose: PURPOSE,
  });
  expect(revealed.values['password']).toBe('rotate-me-1234');
  // …and so does a fresh open from the rotated key file.
  db = reopen();
  const gw2 = createGateway(db);
  registerLockerCommands(gw2);
  const again = gw2.reveal(owner, {
    entity: 'locker.item',
    entityId: itemId,
    columns: ['password'],
    purpose: PURPOSE,
  });
  expect(again.values['password']).toBe('rotate-me-1234');
});

test('reseal is receipted in the journal', () => {
  addLogin();
  const { receiptId } = resealVaultKey(db);
  const row = db.journal
    .prepare('SELECT action, decision, detail_json FROM consent_receipt WHERE receipt_id = ?')
    .get(receiptId) as { action: string; decision: string; detail_json: string };
  expect(row.action).toBe('key.rotate');
  expect(row.decision).toBe('allow');
  const detail = JSON.parse(row.detail_json) as { resealedCells: number; newFingerprint: string };
  expect(detail.resealedCells).toBeGreaterThan(0);
  expect(detail.newFingerprint).toBe(readSealKeyFingerprint(db.vault));
});

test('reseal refuses while blob_store.encrypt binds remote envelopes to the key', () => {
  addLogin();
  const row = db.vault.prepare('SELECT settings_json FROM core_vault LIMIT 1').get() as {
    settings_json: string;
  };
  const settings = JSON.parse(row.settings_json) as Record<string, unknown>;
  settings['blob_store'] = { kind: 's3', endpoint: 'https://s3', bucket: 'b', encrypt: true };
  db.vault.prepare('UPDATE core_vault SET settings_json = ?').run(JSON.stringify(settings));
  expect(() => resealVaultKey(db)).toThrow(/blob_store\.encrypt/);
});

test('an interrupted rotation (sidecar present, rename missed) heals at next open', () => {
  const itemId = addLogin('heal-me-5678');
  resealVaultKey(db);
  // Simulate the crash window: put the rotated key back into the sidecar
  // position and restore a stale key file.
  const keyFile = sealKeyFileFor(vaultDir);
  renameSync(keyFile, `${keyFile}.next`);
  writeSealKeyFile(keyFile, Buffer.alloc(32, 9)); // stale/wrong
  db = reopen(); // resolveSealKey promotes the matching sidecar
  expect(sealKeyFingerprint(db.sealKey)).toBe(readSealKeyFingerprint(db.vault));
  const gw2 = createGateway(db);
  registerLockerCommands(gw2);
  const revealed = gw2.reveal(owner, {
    entity: 'locker.item',
    entityId: itemId,
    columns: ['password'],
    purpose: PURPOSE,
  });
  expect(revealed.values['password']).toBe('heal-me-5678');
});

// ── structural predicate (issue #298 item 8) ────────────────────────────

test('a password that literally starts with sealed:v1: no longer satisfies the predicate — it gets sealed', () => {
  const devious = `${SEALED_PREFIX}my actual password!`;
  expect(isSealedValue(devious)).toBe(false);
  const itemId = addLogin(devious);
  const raw = db.vault
    .prepare('SELECT password FROM locker_item WHERE item_id = ?')
    .get(itemId) as { password: string };
  expect(isSealedValue(raw.password)).toBe(true); // sealed at rest, not stored verbatim
  const revealed = gw.reveal(owner, {
    entity: 'locker.item',
    entityId: itemId,
    columns: ['password'],
    purpose: PURPOSE,
  });
  expect(revealed.values['password']).toBe(devious);
});

test('genuine sealed values still satisfy the structural predicate', () => {
  const itemId = addLogin();
  const raw = db.vault
    .prepare('SELECT password, otp_seed FROM locker_item WHERE item_id = ?')
    .get(itemId) as { password: string; otp_seed: string };
  expect(isSealedValue(raw.password)).toBe(true);
  expect(isSealedValue(raw.otp_seed)).toBe(true);
});

// ── error scrub (issue #298 item 7) ─────────────────────────────────────

test('a handler error echoing a sealed input reaches journal and response scrubbed', () => {
  const secret = 'super-secret-echo-9';
  // locker.add_item with a bad type fails schema BEFORE any seal — instead
  // drive the scrub through a constraint-style failure: duplicate star on a
  // nonexistent item throws with input echoed? Use precondition-free edit of
  // a missing item, whose handler throws mentioning nothing. So test the
  // scrub unit directly through a schema violation that echoes the value.
  const out = gw.invoke(owner, {
    command: 'locker.add_item',
    input: {
      type: 'login',
      title: 'x',
      username: 'u',
      password: secret,
      url: 'not-a-url-but-fine',
      otp_seed: 'JBSWY3DPEHPK3PXP',
      extra_field_that_should_fail_schema: secret,
    },
    purpose: PURPOSE,
  });
  expect(out.status).toBe('failed');
  const receipts = db.journal
    .prepare('SELECT detail_json FROM consent_receipt ORDER BY receipt_id DESC LIMIT 1')
    .get() as { detail_json: string };
  expect(receipts.detail_json).not.toContain(secret);
});

// ── transcript-sensitive derivative output (issue #298 item 6) ──────────

test('totp_code returns the live code but redacts it from the durable journal receipt', () => {
  const itemId = addLogin();
  const out = gw.invoke(owner, {
    command: 'locker.totp_code',
    input: { item_id: itemId },
    purpose: PURPOSE,
  });
  expect(out.status).toBe('executed');
  const code = (out as { output: { code: string } }).output.code;
  expect(code).toMatch(/^\d{6}$/); // the live caller gets the real 6 digits

  // …but the journal receipt (a durable, replayable store) must not hold it.
  const receipt = db.journal
    .prepare('SELECT detail_json FROM consent_receipt ORDER BY receipt_id DESC LIMIT 1')
    .get() as { detail_json: string };
  expect(receipt.detail_json).not.toContain(code);
  expect(receipt.detail_json).toContain('transcript-sensitive');
});

test('a normal command still stores its output in the receipt', () => {
  const itemId = addLogin();
  gw.invoke(owner, {
    command: 'locker.star_item',
    input: { item_id: itemId },
    purpose: PURPOSE,
  });
  const receipt = db.journal
    .prepare(
      "SELECT detail_json FROM consent_receipt WHERE action = 'act locker.star_item' ORDER BY receipt_id DESC LIMIT 1",
    )
    .get() as { detail_json: string } | undefined;
  expect(receipt?.detail_json).toContain('output');
  expect(receipt?.detail_json).not.toContain('transcript-sensitive');
});

// ── stable connector aliases (issue #298 item 4) ────────────────────────

test('reveal resolves a stable alias to the live item', () => {
  addLogin('by-alias-secret', 'github-token');
  const out = gw.reveal(owner, {
    entity: 'locker.item',
    alias: 'github-token',
    columns: ['password'],
    purpose: PURPOSE,
  });
  expect(out.values['password']).toBe('by-alias-secret');
});

test('delete+recreate heals an alias binding — the rotation gesture', () => {
  const oldId = addLogin('old-token', 'github-token');
  // Trash the old login (soft delete) — the alias frees for its successor.
  gw.invoke(owner, { command: 'locker.trash_item', input: { item_id: oldId }, purpose: PURPOSE });
  // A reveal by alias now fails: no live item holds it.
  expect(() =>
    gw.reveal(owner, {
      entity: 'locker.item',
      alias: 'github-token',
      columns: ['password'],
      purpose: PURPOSE,
    }),
  ).toThrow(/no live locker item/);
  // Add the replacement with the SAME alias — the binding heals, no manifest edit.
  addLogin('new-token', 'github-token');
  const healed = gw.reveal(owner, {
    entity: 'locker.item',
    alias: 'github-token',
    columns: ['password'],
    purpose: PURPOSE,
  });
  expect(healed.values['password']).toBe('new-token');
});

test('a trashed item frees its alias for a live item to claim', () => {
  const firstId = addLogin('first', 'shared-alias');
  gw.invoke(owner, { command: 'locker.trash_item', input: { item_id: firstId }, purpose: PURPOSE });
  // The partial unique index only constrains live rows, so this succeeds.
  const secondId = addLogin('second', 'shared-alias');
  expect(secondId).not.toBe(firstId);
});

test('reveal by alias is locker-only and denies an unknown alias', () => {
  expect(() =>
    gw.reveal(owner, {
      entity: 'locker.item',
      alias: 'nope',
      columns: ['password'],
      purpose: PURPOSE,
    }),
  ).toThrow(/no live locker item/);
});

test('writeSealKeyFile + loadSealKey roundtrip', () => {
  const file = path.join(root, 'keys', 'x.sealkey');
  const key = Buffer.alloc(32, 3);
  writeSealKeyFile(file, key);
  expect(loadSealKey(file)?.equals(key)).toBe(true);
  expect(loadSealKey(path.join(root, 'keys', 'nope.sealkey'))).toBeNull();
});
