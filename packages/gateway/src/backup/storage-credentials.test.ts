import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * `ensureProviderCasTarget` learns the provider's declared storage-class list
 * from the SAME discovery document it already reads for the `derived` grant
 * (issue #425 Wave 3), so the CAS-attach route can stamp
 * `blob_store.supportedStorageClasses` into the vault. Exercised against the
 * real in-process fake provider server (real HTTP, real grant flow).
 */

import { afterEach, expect, test } from 'vitest';
import { startFakeProviderServer } from '@centraid/backup/dist/testing/fake-provider-server.js';
import { openStorageConnectionStore } from './storage-connections.js';
import { ensureProviderCasTarget } from './storage-credentials.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
test('ensureProviderCasTarget stamps the declared storage-class list (issue #425 Wave 3)', async () => {
  const provider = await startFakeProviderServer();
  cleanups.push(() => provider.close());
  const store = await openStorageConnectionStore(await tempDir());
  const connection = await store.create({
    kind: 'provider',
    name: 'Clawgnition',
    baseUrl: provider.url,
    apiKey: provider.apiKey,
  });

  const target = await ensureProviderCasTarget(store, connection.id);

  // The fake advertises ['STANDARD', 'STANDARD_IA'] + the `derived` capability.
  expect(target.supportedStorageClasses).toEqual(['STANDARD', 'STANDARD_IA']);
  expect(target.derivedPrefix).toBeTruthy();
  expect(target.bucket).toBeTruthy();
  expect(target.prefix).toBeTruthy();
});
