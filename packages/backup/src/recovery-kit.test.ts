import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * The recovery-kit READER (issue #439 R1) — the counterpart to
 * `writeRecoveryKit`. A kit is the ONLY thing standing between a blank machine
 * and a vault, so the parser is strict: a wrong kind, an unsupported version, a
 * malformed keyring, or a target missing its addressing is refused HERE, not
 * three phases into a restore. These pin exactly that.
 */

import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createKeyring, parseRecoveryKit, writeRecoveryKit } from './index.js';

async function tempFile(name: string): Promise<string> {
  const dir = await tempDir(`recovery-kit-${crypto.randomUUID()}-`);
  return path.join(dir, name);
}

test('round-trips a kit written by writeRecoveryKit', async () => {
  const keyringFile = await tempFile('keyring.json');
  const keyring = await createKeyring(keyringFile);
  const kitFile = await tempFile('kit.json');
  await writeRecoveryKit({
    keyring,
    targets: [{ provider: 'https://home.example', targetId: 't-1', vaultId: 'v-1', label: 'ab12' }],
    destFile: kitFile,
  });

  const doc = parseRecoveryKit(JSON.parse(await fs.readFile(kitFile, 'utf8')));
  expect(doc.kind).toBe('centraid-recovery-kit');
  expect(doc.version).toBe(1);
  expect(doc.keyring.epochs.length).toBeGreaterThan(0);
  expect(doc.targets).toEqual([
    { provider: 'https://home.example', targetId: 't-1', vaultId: 'v-1', label: 'ab12' },
  ]);
});

test('rejects a document that is not a centraid recovery kit', () => {
  expect(() => parseRecoveryKit({ kind: 'something-else', version: 1 })).toThrow(
    /not a centraid-recovery-kit/,
  );
  expect(() => parseRecoveryKit(null)).toThrow(/not an object/);
});

test('rejects an unsupported version', async () => {
  const keyring = await createKeyring(await tempFile('k.json'));
  expect(() =>
    parseRecoveryKit({
      kind: 'centraid-recovery-kit',
      version: 2,
      keyring,
      targets: [{ provider: 'x', targetId: 't', vaultId: 'v', label: 'l' }],
    }),
  ).toThrow(/unsupported version/);
});

test('rejects a malformed keyring with the same rules loadKeyring uses', () => {
  expect(() =>
    parseRecoveryKit({
      kind: 'centraid-recovery-kit',
      version: 1,
      keyring: { version: 1, active: 1, epochs: [] },
      targets: [{ provider: 'x', targetId: 't', vaultId: 'v', label: 'l' }],
    }),
  ).toThrow(/keyring/);
});

test('rejects an empty target list and a target missing addressing', async () => {
  const keyring = await createKeyring(await tempFile('k.json'));
  expect(() =>
    parseRecoveryKit({ kind: 'centraid-recovery-kit', version: 1, keyring, targets: [] }),
  ).toThrow(/non-empty array/);
  expect(() =>
    parseRecoveryKit({
      kind: 'centraid-recovery-kit',
      version: 1,
      keyring,
      targets: [{ provider: 'x', vaultId: 'v', label: 'l' }],
    }),
  ).toThrow(/missing "targetId"/);
});
