import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { commandVault } from './vault-admin.ts';

let dataDir: string;

class CliFailError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'CliFailError';
  }
}

const fail = (message: string, code = 1): never => {
  throw new CliFailError(message, code);
};

async function capture(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

function lastJson(text: string): Record<string, unknown> {
  const lines = text.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

beforeEach(async () => {
  dataDir = await tempDir(`vault-admin-${crypto.randomUUID()}-`);
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('vault create / list / rename / delete over the admin plane', async () => {
  const created = lastJson(
    await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail)),
  );
  expect(created).toMatchObject({ name: 'Family' });
  const listed = (await capture(() => commandVault(['list', '--data-dir', dataDir], fail)))
    .trim()
    .split('\n')
    .filter(Boolean);
  expect(listed).toHaveLength(2);
  const renamed = lastJson(
    await capture(() =>
      commandVault(['rename', '--data-dir', dataDir, created.vaultId as string, 'Sharma'], fail),
    ),
  );
  expect(renamed).toMatchObject({ name: 'Sharma' });
  const deleted = lastJson(
    await capture(() =>
      commandVault(['delete', '--data-dir', dataDir, created.vaultId as string], fail),
    ),
  );
  expect(deleted).toMatchObject({ deleted: created.vaultId });
});

test('vault admin rejects bad usage + the last-vault delete', async () => {
  await expect(capture(() => commandVault(['bogus', '--data-dir', dataDir], fail))).rejects.toThrow(
    /list, create, rename, delete/,
  );
  await expect(capture(() => commandVault(['list'], fail))).rejects.toThrow(/--data-dir/);
  await expect(
    capture(() => commandVault(['rename', '--data-dir', dataDir], fail)),
  ).rejects.toThrow(/vault rename/);
  const only = lastJson(await capture(() => commandVault(['create', '--data-dir', dataDir], fail)));
  const [first] = (await capture(() => commandVault(['list', '--data-dir', dataDir], fail)))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { vaultId: string });
  await capture(() => commandVault(['delete', '--data-dir', dataDir, first!.vaultId], fail));
  await expect(
    capture(() => commandVault(['delete', '--data-dir', dataDir, only.vaultId as string], fail)),
  ).rejects.toThrow(/last vault/);
});

test('vault list/create --json wrap output in one {ok,...} line (issue #382)', async () => {
  const created = lastJson(
    await capture(() =>
      commandVault(['create', '--data-dir', dataDir, '--name', 'Family', '--json'], fail),
    ),
  );
  expect(created).toEqual({ ok: true, vaultId: expect.any(String), name: 'Family' });
  const listed = lastJson(
    await capture(() => commandVault(['list', '--data-dir', dataDir, '--json'], fail)),
  );
  expect(listed.ok).toBe(true);
  expect(Array.isArray(listed.vaults)).toBe(true);
  expect((listed.vaults as unknown[]).length).toBe(2);
  expect(listed.vaults).toContainEqual(
    expect.objectContaining({ vaultId: created.vaultId, name: 'Family' }),
  );
});

test('vault --json failure emits {ok:false,error,message} on stdout, then still fails the process', async () => {
  let captured = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await expect(commandVault(['list', '--json'], fail)).rejects.toThrow(/--data-dir/);
  } finally {
    process.stdout.write = original;
  }
  const parsed = lastJson(captured);
  expect(parsed).toMatchObject({ ok: false, error: 'usage' });
  expect(parsed.message).toMatch(/--data-dir/);
});
