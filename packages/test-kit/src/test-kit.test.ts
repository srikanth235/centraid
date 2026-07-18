import { accessSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { createTestVault } from './factories.js';
import { useFakeClock } from './fake-clock.js';
import { tempDir, tempDirSync } from './temp-dir.js';
import { generateVolumeFixture } from './volume-fixture.js';

test('tempDir creates an accessible tracked directory', async () => {
  const dir = await tempDir('centraid-kit-');
  await expect(access(dir)).resolves.toBeUndefined();
});

test('tempDirSync supports synchronous hooks and constructors', () => {
  expect(() => accessSync(tempDirSync('centraid-kit-sync-'))).not.toThrow();
});

test('fake clock advances deterministically', async () => {
  const clock = useFakeClock('2026-07-18T00:00:00Z');
  const before = clock.now();
  await clock.advance(2_500);
  expect(clock.now()).toBe(before + 2_500);
});

test('createTestVault opens a migrated production-shape vault', async () => {
  const db = await createTestVault();
  const row = db.vault.prepare('SELECT count(*) AS n FROM core_vault').get() as { n: number };
  expect(row.n).toBe(1);
});

test('volume fixtures are deterministic and preserve requested cardinality', () => {
  const options = {
    seed: 9,
    parties: 3,
    photos: 12,
    replicaRows: 17,
    conversations: 4,
    turnsPerConversation: 7,
  };
  const first = generateVolumeFixture(options);
  const second = generateVolumeFixture(options);
  expect(second).toEqual(first);
  expect(first.photos).toHaveLength(12);
  expect(first.blobs).toHaveLength(12);
  expect(first.replicaRows).toHaveLength(17);
  expect(first.conversations.flatMap((conversation) => conversation.turns)).toHaveLength(28);
});
