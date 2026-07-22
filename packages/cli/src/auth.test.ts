import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { resolveToken } from './auth.ts';

test('resolveToken prefers --token over env and data-dir', async () => {
  const dir = await tempDir('cli-auth-');
  await fs.writeFile(path.join(dir, 'token.bin'), 'from-file\n', { mode: 0o600 });
  const token = await resolveToken({
    token: 'explicit',
    dataDir: dir,
    env: { CENTRAID_TOKEN: 'from-env' },
  });
  expect(token).toBe('explicit');
});

test('resolveToken reads token.bin from data-dir', async () => {
  const dir = await tempDir('cli-auth-file-');
  await fs.writeFile(path.join(dir, 'token.bin'), 'file-token\n', { mode: 0o600 });
  const token = await resolveToken({ dataDir: dir, env: {} });
  expect(token).toBe('file-token');
});

test('resolveToken uses CENTRAID_TOKEN when no --token', async () => {
  const token = await resolveToken({ env: { CENTRAID_TOKEN: 'env-token' } });
  expect(token).toBe('env-token');
});
