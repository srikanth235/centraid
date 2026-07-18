import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Per-device HTTP bearer tokens (issue #376) — mint/authorize/revoke over
 * the cross-process JSON store (same reload-on-mtime contract as its
 * `enrollment-store.ts`/`pairing-store.ts` siblings).
 */

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DeviceTokenStore, formatDeviceToken, parseDeviceToken } from './device-token-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempFile(name: string): Promise<string> {
  const dir = await tempDir(`device-tokens-${crypto.randomUUID()}-`);
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

test('mint returns a working cdt_ token; authorize resolves it back to the device key', async () => {
  const file = await tempFile('device-tokens.json');
  const store = DeviceTokenStore.open(file);

  const { token } = store.mint({ deviceKey: 'http:abc', label: 'Priya phone' });
  expect(token).toMatch(/^cdt_/);
  expect(store.authorize(token)).toEqual({ deviceKey: 'http:abc' });

  // Wrong secret, unknown id, and garbage all fail the same way.
  const parsed = parseDeviceToken(token)!;
  expect(store.authorize(formatDeviceToken(parsed.tokenId, 'wrong-secret'))).toBeUndefined();
  expect(store.authorize(formatDeviceToken(crypto.randomUUID(), parsed.secret))).toBeUndefined();
  expect(store.authorize('not-a-device-token')).toBeUndefined();
  expect(store.authorize('')).toBeUndefined();
});

test('one token per device: re-minting invalidates the prior token', async () => {
  const file = await tempFile('device-tokens.json');
  const store = DeviceTokenStore.open(file);

  const first = store.mint({ deviceKey: 'http:abc', label: 'first' });
  const second = store.mint({ deviceKey: 'http:abc', label: 'second' });

  expect(store.authorize(first.token)).toBeUndefined();
  expect(store.authorize(second.token)).toEqual({ deviceKey: 'http:abc' });
  expect(store.list()).toHaveLength(1);
});

test('revokeForDeviceKey kills every token that device key held', async () => {
  const file = await tempFile('device-tokens.json');
  const store = DeviceTokenStore.open(file);

  const a = store.mint({ deviceKey: 'http:a', label: 'a' });
  const b = store.mint({ deviceKey: 'http:b', label: 'b' });

  const removed = store.revokeForDeviceKey('http:a');
  expect(removed).toHaveLength(1);
  expect(store.authorize(a.token)).toBeUndefined();
  expect(store.authorize(b.token)).toEqual({ deviceKey: 'http:b' });

  // Revoking a key with nothing to revoke is a no-op, not an error.
  expect(store.revokeForDeviceKey('http:gone')).toEqual([]);
});

test('a second process (fresh .open()) sees writes via mtime reload', async () => {
  const file = await tempFile('device-tokens.json');
  const writer = DeviceTokenStore.open(file);
  const { token } = writer.mint({ deviceKey: 'http:cross-proc', label: 'x' });

  const reader = DeviceTokenStore.open(file);
  expect(reader.authorize(token)).toEqual({ deviceKey: 'http:cross-proc' });
});
