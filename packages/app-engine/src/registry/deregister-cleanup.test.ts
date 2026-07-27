import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cleanupDeregisteredApp } from './deregister-cleanup.ts';
import type { RegistryEntry } from '../types.ts';

let workspace: string;
let appsDir: string;
const warnings: string[] = [];
const logger = {
  warn(m: string) {
    warnings.push(m);
  },
};

describe('deregister-cleanup', () => {
  beforeEach(async () => {
    workspace = await tempDir('centraid-cleanup-');
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
      registeredAt: new Date().toISOString(),
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
    expect((await fs.stat(entry.path)).isDirectory()).toBeTruthy();

    const result = await cleanupDeregisteredApp(appsDir, entry, logger);

    expect(result).toStrictEqual({ kind: 'removed' });
    await expect(fs.stat(entry.path)).rejects.toThrow(/ENOENT/);
    expect(warnings).toHaveLength(0);
  });

  test('removes data.sqlite, current.json, and all versions', async () => {
    const entry = makeUploadedEntry('myapp-xyz');
    await seedAppDir(entry);

    await cleanupDeregisteredApp(appsDir, entry, logger);

    await expect(fs.stat(path.join(entry.path, 'data.sqlite'))).rejects.toThrow(/ENOENT/);
    await expect(fs.stat(path.join(entry.path, 'current.json'))).rejects.toThrow(/ENOENT/);
    await expect(fs.stat(path.join(entry.path, 'versions'))).rejects.toThrow(/ENOENT/);
  });

  test('appsDir itself is preserved', async () => {
    const a = makeUploadedEntry('app-a');
    const b = makeUploadedEntry('app-b');
    await seedAppDir(a);
    await seedAppDir(b);

    await cleanupDeregisteredApp(appsDir, a, logger);

    // Sibling app dir + appsDir survive — only the targeted entry is touched.
    expect((await fs.stat(appsDir)).isDirectory()).toBeTruthy();
    expect((await fs.stat(b.path)).isDirectory()).toBeTruthy();
    await expect(fs.stat(a.path)).rejects.toThrow(/ENOENT/);
  });

  test('refuses to remove a corrupt entry whose path is outside appsDir', async () => {
    const externalDir = path.join(workspace, 'outside');
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(path.join(externalDir, 'keep.txt'), 'safe');

    // Simulate a corrupt registry row whose path is not under appsDir.
    // The defense-in-depth check should refuse.
    const entry: RegistryEntry = {
      id: 'corrupt',
      path: externalDir,
      registeredAt: new Date().toISOString(),
    };

    const result = await cleanupDeregisteredApp(appsDir, entry, logger);

    expect(result).toStrictEqual({ kind: 'skipped', reason: 'outside-appsdir' });
    expect((await fs.stat(externalDir)).isDirectory()).toBeTruthy();
    expect((await fs.stat(path.join(externalDir, 'keep.txt'))).isFile()).toBeTruthy();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!).toMatch(/outside appsDir/);
  });

  test('refuses when path === appsDir (would wipe the entire state dir)', async () => {
    const entry: RegistryEntry = {
      id: 'evil',
      path: appsDir,
      registeredAt: new Date().toISOString(),
    };

    const result = await cleanupDeregisteredApp(appsDir, entry, logger);

    expect(result).toStrictEqual({ kind: 'skipped', reason: 'outside-appsdir' });
    expect((await fs.stat(appsDir)).isDirectory()).toBeTruthy();
  });

  test('refuses on traversal attempts via "..", appsDir untouched', async () => {
    const traversal = path.join(appsDir, '..', 'outside');
    await fs.mkdir(traversal, { recursive: true });
    await fs.writeFile(path.join(traversal, 'keep.txt'), 'safe');

    const entry: RegistryEntry = {
      id: 'traversal',
      path: traversal,
      registeredAt: new Date().toISOString(),
    };

    const result = await cleanupDeregisteredApp(appsDir, entry, logger);

    expect(result).toStrictEqual({ kind: 'skipped', reason: 'outside-appsdir' });
    expect((await fs.stat(path.join(traversal, 'keep.txt'))).isFile()).toBeTruthy();
  });

  test('treats a missing wrapper dir as success (idempotent)', async () => {
    const entry = makeUploadedEntry('never-uploaded');
    // Don't create entry.path — registry row exists but dir doesn't.

    const result = await cleanupDeregisteredApp(appsDir, entry, logger);

    // fs.rm with force:true treats ENOENT as success — that's the intended
    // semantic: deregister stays idempotent even if disk state already drifted.
    expect(result).toStrictEqual({ kind: 'removed' });
    expect(warnings).toHaveLength(0);
  });
});
