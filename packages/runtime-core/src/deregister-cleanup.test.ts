import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { cleanupDeregisteredApp } from './deregister-cleanup.ts';
import type { RegistryEntry } from './types.ts';

let workspace: string;
let appsDir: string;
const warnings: string[] = [];
const logger = {
  warn(m: string) {
    warnings.push(m);
  },
};

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-cleanup-'));
  appsDir = path.join(workspace, 'centraid');
  await fs.mkdir(appsDir, { recursive: true });
  warnings.length = 0;
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function makeUploadedEntry(id: string): RegistryEntry {
  return {
    id,
    path: path.join(appsDir, id),
    mode: 'uploaded',
    registeredAt: new Date().toISOString(),
    cronTokens: {},
    cronStatus: {},
  };
}

async function seedAppDir(entry: RegistryEntry): Promise<void> {
  await fs.mkdir(path.join(entry.path, 'versions', 'v_2026-05-12T00-00-00-000Z_abc123'), {
    recursive: true,
  });
  await fs.writeFile(path.join(entry.path, 'data.sqlite'), crypto.randomBytes(16));
  await fs.writeFile(
    path.join(entry.path, 'current.json'),
    JSON.stringify({ activeVersion: 'v_2026-05-12T00-00-00-000Z_abc123', history: [] }),
  );
  await fs.writeFile(
    path.join(entry.path, 'versions', 'v_2026-05-12T00-00-00-000Z_abc123', 'index.html'),
    '<!doctype html>',
  );
}

test('removes the wrapper dir for an uploaded app', async () => {
  const entry = makeUploadedEntry('myapp-abc123');
  await seedAppDir(entry);
  assert.ok((await fs.stat(entry.path)).isDirectory(), 'precondition: dir exists');

  const result = await cleanupDeregisteredApp(appsDir, entry, logger);

  assert.deepEqual(result, { kind: 'removed' });
  await assert.rejects(fs.stat(entry.path), /ENOENT/, 'wrapper dir should be gone');
  assert.equal(warnings.length, 0);
});

test('removes data.sqlite, current.json, and all versions', async () => {
  const entry = makeUploadedEntry('myapp-xyz');
  await seedAppDir(entry);

  await cleanupDeregisteredApp(appsDir, entry, logger);

  await assert.rejects(fs.stat(path.join(entry.path, 'data.sqlite')));
  await assert.rejects(fs.stat(path.join(entry.path, 'current.json')));
  await assert.rejects(fs.stat(path.join(entry.path, 'versions')));
});

test('appsDir itself is preserved', async () => {
  const a = makeUploadedEntry('app-a');
  const b = makeUploadedEntry('app-b');
  await seedAppDir(a);
  await seedAppDir(b);

  await cleanupDeregisteredApp(appsDir, a, logger);

  // Sibling app dir + appsDir survive — only the targeted entry is touched.
  assert.ok((await fs.stat(appsDir)).isDirectory());
  assert.ok((await fs.stat(b.path)).isDirectory());
  await assert.rejects(fs.stat(a.path));
});

test('skips path-mode entries (user-owned dir, never delete)', async () => {
  // User registered an external dir outside appsDir — we must not touch it.
  const externalDir = path.join(workspace, 'user-stuff');
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(path.join(externalDir, 'precious.txt'), 'do not delete me');

  const entry: RegistryEntry = {
    id: 'external',
    path: externalDir,
    mode: 'path',
    registeredAt: new Date().toISOString(),
    cronTokens: {},
    cronStatus: {},
  };

  const result = await cleanupDeregisteredApp(appsDir, entry, logger);

  assert.deepEqual(result, { kind: 'skipped', reason: 'path-mode' });
  assert.ok((await fs.stat(externalDir)).isDirectory());
  assert.equal(
    await fs.readFile(path.join(externalDir, 'precious.txt'), 'utf8'),
    'do not delete me',
  );
});

test('refuses to remove a corrupt entry whose path is outside appsDir', async () => {
  const externalDir = path.join(workspace, 'outside');
  await fs.mkdir(externalDir, { recursive: true });
  await fs.writeFile(path.join(externalDir, 'keep.txt'), 'safe');

  // Simulate a corrupt registry row: mode says "uploaded" but path is not
  // under appsDir. The defense-in-depth check should refuse.
  const entry: RegistryEntry = {
    id: 'corrupt',
    path: externalDir,
    mode: 'uploaded',
    registeredAt: new Date().toISOString(),
    cronTokens: {},
    cronStatus: {},
  };

  const result = await cleanupDeregisteredApp(appsDir, entry, logger);

  assert.deepEqual(result, { kind: 'skipped', reason: 'outside-appsdir' });
  assert.ok((await fs.stat(externalDir)).isDirectory());
  assert.ok((await fs.stat(path.join(externalDir, 'keep.txt'))).isFile());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /outside appsDir/);
});

test('refuses when path === appsDir (would wipe the entire state dir)', async () => {
  const entry: RegistryEntry = {
    id: 'evil',
    path: appsDir,
    mode: 'uploaded',
    registeredAt: new Date().toISOString(),
    cronTokens: {},
    cronStatus: {},
  };

  const result = await cleanupDeregisteredApp(appsDir, entry, logger);

  assert.deepEqual(result, { kind: 'skipped', reason: 'outside-appsdir' });
  assert.ok((await fs.stat(appsDir)).isDirectory(), 'appsDir survives');
});

test('refuses on traversal attempts via "..", appsDir untouched', async () => {
  const traversal = path.join(appsDir, '..', 'outside');
  await fs.mkdir(traversal, { recursive: true });
  await fs.writeFile(path.join(traversal, 'keep.txt'), 'safe');

  const entry: RegistryEntry = {
    id: 'traversal',
    path: traversal,
    mode: 'uploaded',
    registeredAt: new Date().toISOString(),
    cronTokens: {},
    cronStatus: {},
  };

  const result = await cleanupDeregisteredApp(appsDir, entry, logger);

  assert.deepEqual(result, { kind: 'skipped', reason: 'outside-appsdir' });
  assert.ok((await fs.stat(path.join(traversal, 'keep.txt'))).isFile());
});

test('treats a missing wrapper dir as success (idempotent)', async () => {
  const entry = makeUploadedEntry('never-uploaded');
  // Don't create entry.path — registry row exists but dir doesn't.

  const result = await cleanupDeregisteredApp(appsDir, entry, logger);

  // fs.rm with force:true treats ENOENT as success — that's the intended
  // semantic: deregister stays idempotent even if disk state already drifted.
  assert.deepEqual(result, { kind: 'removed' });
  assert.equal(warnings.length, 0);
});
