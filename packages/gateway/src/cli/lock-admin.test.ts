import { buildGatewayInfoPayload } from '@centraid/protocol';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { endpointIdForSecret } from '@centraid/tunnel';
import { KeyStore } from '@centraid/vault';
import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import { GatewayDatabase } from '../serve/gateway-db.js';
import { commandLockStatus } from './lock-admin.js';
import { daemonLayoutFor } from './paths.js';
import { commandVault } from './vault-admin.js';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const fail = (message: string): never => {
  throw new Error(message);
};

async function capture(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('mutating CLI refuses the daemon lock while read-only vault list succeeds', async () => {
  const dataDir = await tempDir('gateway-cli-lock-');
  roots.push(dataDir);
  const held = GatewayDatabase.open(dataDir, { lock: 'exclusive' });
  try {
    await expect(
      commandVault(['create', '--data-dir', dataDir, '--name', 'Blocked'], fail),
    ).rejects.toThrow(/running daemon|another Centraid gateway/i);
    await expect(
      capture(() => commandVault(['list', '--data-dir', dataDir, '--json'], fail)),
    ).resolves.toContain('"vaults":[]');
  } finally {
    held.close();
  }
});

test('lock-status distinguishes an answering daemon from a wedged holder', async () => {
  const dataDir = await tempDir('gateway-lock-status-');
  roots.push(dataDir);
  const layout = daemonLayoutFor(dataDir);
  const secret = Buffer.alloc(32, 0x55);
  new KeyStore(layout.keysDir).store('endpoint-key.bin', secret);
  const endpointId = endpointIdForSecret(secret);
  const held = GatewayDatabase.open(dataDir, { lock: 'exclusive' });
  const answeringFetch = (async () =>
    Response.json(
      buildGatewayInfoPayload({
        instanceId: 'answering',
        startedAt: Date.now(),
        uptimeMs: 1,
        endpointId,
      }),
    )) as typeof fetch;
  const wedgedFetch = (async () =>
    Response.json({ error: 'wedged' }, { status: 503 })) as typeof fetch;

  try {
    const answering = JSON.parse(
      await capture(() =>
        commandLockStatus(['--data-dir', dataDir, '--json'], fail, answeringFetch, {
          holderPid: () => 101,
        }),
      ),
    ) as Record<string, unknown>;
    expect(answering).toMatchObject({
      held: true,
      answering: true,
      holderPid: 101,
      detail: 'gateway.db is held by the answering daemon',
    });

    const wedged = JSON.parse(
      await capture(() =>
        commandLockStatus(['--data-dir', dataDir, '--json'], fail, wedgedFetch, {
          holderPid: () => 202,
        }),
      ),
    ) as Record<string, unknown>;
    expect(wedged).toMatchObject({
      held: true,
      answering: false,
      holderPid: 202,
    });
    expect(wedged.detail).toMatch(/held but the daemon is not answering.*OS holder pid 202/i);
    await expect(
      commandLockStatus(['--data-dir', dataDir, '--force'], fail, wedgedFetch),
    ).rejects.toThrow(/unknown flag "--force"/);
  } finally {
    held.close();
  }
});
