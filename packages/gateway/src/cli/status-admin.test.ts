import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * `centraid-gateway status` (issue #382) — a data-dir-only unit test:
 * `--data-dir` given but no service ever installed, so `queryServiceStatus`
 * reports `installed: false` without shelling out to a real launchd/systemd
 * (both platforms handle "unit not found" as a normal, zero-exit read — see
 * `service-admin.ts`'s `launchdStatusInfo`/`systemdStatusInfo`). Darwin and
 * Linux CI runners both exercise the real OS probe this way; a `win32` CI
 * runner would hit the "not supported" branch instead — acceptable, `status`
 * inherits `service`'s two-platform scope.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { commandStatus } from './status-admin.ts';
import { commandVault } from './vault-admin.ts';
import { daemonLayoutFor } from './paths.ts';

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

let dataDir: string;

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
  dataDir = await tempDir(`status-admin-${crypto.randomUUID()}-`);
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('status --json with no --data-dir reports service only (never-installed unit reads clean)', async () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const parsed = lastJson(await capture(() => commandStatus(['--json'], fail)));
  expect(parsed.ok).toBe(true);
  expect(parsed.dataDir).toBeUndefined();
  const service = parsed.service as { installed: boolean; label: string };
  expect(service.installed).toBe(false);
  expect(typeof service.label).toBe('string');
});

test('status --json with --data-dir adds the data-dir summary (exists, endpoint identity, vault count)', async () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  // A bootstrapped vault + a published endpoint identity, same as a daemon
  // that has actually booted once.
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail));
  const layout = daemonLayoutFor(dataDir);
  await fs.writeFile(
    layout.endpointStateFile,
    JSON.stringify({ endpointId: 'gw-endpoint-abc', ticket: 'gw-ticket-base32' }),
  );

  const parsed = lastJson(
    await capture(() => commandStatus(['--data-dir', dataDir, '--json'], fail)),
  );
  expect(parsed.ok).toBe(true);
  const summary = parsed.dataDir as {
    exists: boolean;
    endpointId?: string;
    vaultCount?: number;
  };
  expect(summary.exists).toBe(true);
  expect(summary.endpointId).toBe('gw-endpoint-abc');
  // The bootstrapped default vault + the one just created.
  expect(summary.vaultCount).toBe(2);
});

test('status --json against a --data-dir that does not exist reports exists:false, no throw', async () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const missing = path.join(dataDir, 'never-created');
  const parsed = lastJson(
    await capture(() => commandStatus(['--data-dir', missing, '--json'], fail)),
  );
  expect(parsed.ok).toBe(true);
  const summary = parsed.dataDir as { exists: boolean; endpointId?: string };
  expect(summary.exists).toBe(false);
  expect(summary.endpointId).toBeUndefined();
});

test('status (human mode) prints readable lines, not JSON', async () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const text = await capture(() => commandStatus(['--data-dir', dataDir], fail));
  expect(text).toContain('service:');
  expect(text).toContain('data dir:');
  expect(() => JSON.parse(text)).toThrow();
});

test('status --json rejects an unknown flag as a usage error', async () => {
  let captured = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await expect(commandStatus(['--bogus', '--json'], fail)).rejects.toThrow(/unknown flag/);
  } finally {
    process.stdout.write = original;
  }
  const parsed = lastJson(captured);
  expect(parsed).toMatchObject({ ok: false, error: 'usage' });
});
