/* oxlint-disable typescript-eslint/ban-ts-comment -- this test drives an untyped
   browser blueprint under jsdom while the package's TypeScript config is
   intentionally Node-only. */
// @ts-nocheck
// @vitest-environment jsdom
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const PKG = path.resolve(import.meta.dirname, '..');
const SCRATCH = path.resolve(PKG, '.locker-online-only');

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  for (const file of ['logic.ts', 'format.ts', 'totp.ts', 'types.ts']) {
    cpSync(path.resolve(PKG, 'apps/locker', file), path.resolve(SCRATCH, file));
  }
  for (const file of ['kit.ts', 'elements.js']) {
    symlinkSync(path.resolve(PKG, 'kit', file), path.resolve(SCRATCH, file));
  }
});

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe('Locker sealed writes', () => {
  it('marks add and edit payloads online-only while leaving non-secret actions queueable', async () => {
    const { createLogic } = await import(pathToFileURL(path.resolve(SCRATCH, 'logic.ts')).href);
    const write = vi.fn(async () => ({ status: 'failed', error: 'expected test stop' }));
    window.centraid = { write };
    const logic = createLogic({
      state: {},
      data: {},
      render: vi.fn(),
      refresh: vi.fn(),
    });
    const common = {
      type: 'login',
      title: 'Email',
      tags: 'personal',
      alias: '',
      fields: { username: 'me@example.test', password: 'do-not-persist' },
      allowedKeys: ['username', 'password'],
    };

    await logic.saveItem({ mode: 'new', ...common });
    await logic.saveItem({ mode: 'edit', id: 'item-1', ...common });
    await logic.act('star-item', { item_id: 'item-1' });

    expect(write).toHaveBeenNthCalledWith(1, {
      action: 'add-item',
      input: {
        type: 'login',
        title: 'Email',
        tags: ['personal'],
        username: 'me@example.test',
        password: 'do-not-persist',
      },
      onlineOnly: true,
    });
    expect(write).toHaveBeenNthCalledWith(2, {
      action: 'edit-item',
      input: {
        item_id: 'item-1',
        title: 'Email',
        tags: ['personal'],
        username: 'me@example.test',
        password: 'do-not-persist',
      },
      onlineOnly: true,
    });
    expect(write).toHaveBeenNthCalledWith(3, {
      action: 'star-item',
      input: { item_id: 'item-1' },
    });
  });
});
