import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * The LIVE-gateway recovery e2e (issue #555): a zero-vault gateway consumes a
 * founding ticket plus recovery kit through the single founding restore route.
 * The recovered vault is mounted, quarantined, and owned by the proved first
 * device; no temporary default vault or separate recovery authority exists.
 */

import { afterEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import crypto, { randomBytes } from 'node:crypto';
import {
  openRemoteBackupProvider,
  wrapRecoveryKit,
  type RecoveryKitDocument,
} from '@centraid/backup';
import { startFakeProviderServer } from '@centraid/backup/dist/testing/fake-provider-server.js';
import { KeyStore, ReplicaIndex } from '@centraid/vault';
import { openVaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { serve, type GatewayServeHandle } from '../serve/serve.js';
import { BackupService } from './backup-service.js';
import { GatewayDatabase } from '../serve/gateway-db.js';
import {
  encodePairingTicket,
  FOUNDING_TICKET_TTL_MS,
  PairingTicketStore,
} from '../serve/pairing-store.js';

vi.setConfig({ testTimeout: 30_000 });

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
function invoke(
  plane: VaultPlane,
  command: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
  if (out.status !== 'executed') throw new Error(`${command} failed: ${JSON.stringify(out)}`);
  return (out as { output: Record<string, unknown> }).output;
}

function stage(plane: VaultPlane, bytes: Buffer, name: string): string {
  return plane.gateway.stageBlob(plane.ownerCredential, {
    bytes,
    mediaType: 'application/octet-stream',
    filename: name,
  }).sha256;
}

/** Declare the vault remote-primary (an s3 `blob_store`) so the RESTORED vault.db
 *  carries s3 settings — the live gateway's registry (which wires an
 *  `s3Credentials` resolver) then yields a non-null `db.remote()`, so the warm
 *  pass runs. The endpoint is never actually dialed: every thumb is materialized
 *  local by the restore, so the warm pass is all local hits. */
function declareRemotePrimary(plane: VaultPlane): void {
  const row = plane.db.vault.prepare('SELECT settings_json FROM core_vault LIMIT 1').get() as {
    settings_json: string | null;
  };
  const settings = row.settings_json
    ? (JSON.parse(row.settings_json) as Record<string, unknown>)
    : {};
  plane.db.vault.prepare('UPDATE core_vault SET settings_json = ?').run(
    JSON.stringify({
      ...settings,
      blob_store: { kind: 's3', endpoint: 'https://home.invalid', bucket: 'recover-live' },
    }),
  );
}

/** A sealed credential + approved outbox item + standing grant — the live states
 *  the quarantine must neutralize; the sealed secret also mints the seal key, so
 *  the recovered vault only mounts if `recover()` placed it. */
function seedSealedOutbox(plane: VaultPlane): void {
  invoke(plane, 'sync.configure_credential', {
    kind: 'pull.gmail',
    label: 'personal',
    cred_kind: 'api_key',
    api_key: 'sk-recover-live',
    allowed_hosts: ['gmail.googleapis.com'],
  });
  const itemId = invoke(plane, 'outbox.stage', {
    kind: 'pull.gmail',
    label: 'personal',
    verb: 'gmail.send',
    target: 'ravi@example.com',
    artifact: { to: 'ravi@example.com', subject: 'Hi', body: 'See you.' },
    request: {
      method: 'POST',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      headers: { authorization: 'Bearer {{connection:api_key}}' },
      body: '{"raw":"x"}',
    },
  })['item_id'] as string;
  const grantId = crypto.randomUUID();
  plane.db.vault
    .prepare(
      `INSERT INTO outbox_grant (grant_id, actor_id, verb, target, created_at, revoked_at)
       VALUES (?, 'owner', 'gmail.send', 'ravi@example.com', ?, NULL)`,
    )
    .run(grantId, new Date().toISOString());
  plane.db.vault
    .prepare(
      `UPDATE outbox_item SET status = 'approved', decided_at = ?, grant_id = ? WHERE item_id = ?`,
    )
    .run(new Date().toISOString(), grantId, itemId);
}

interface MachineA {
  vaultId: string;
  vaultIds: string[];
  targetId: string;
  kitDocument: RecoveryKitDocument;
  apiKey: string;
  serverUrl: string;
}

async function seedMachineA(
  server: Awaited<ReturnType<typeof startFakeProviderServer>>,
  includeSecondVault = false,
): Promise<MachineA> {
  const registry = openVaultRegistry({
    rootDir: await tempDir('recover-live-a'),
    logger: silentLogger,
    ownerName: 'Mara',
  });
  registry.create('Personal');
  cleanups.push(() => registry.stop());
  const vaultId = registry.defaultVaultId();
  const plane = registry.get(vaultId)!;
  const service = new BackupService({
    config: {
      enabled: true,
      provider: { kind: 'remote', endpoint: server.url, apiKey: server.apiKey },
    },
    cacheDir: await tempDir('recover-live-a-backup'),
    vaults: registry,
    health: new HealthRegistry(),
    logger: silentLogger,
  });
  cleanups.push(() => service.stop());

  const originals: string[] = [];
  for (let i = 0; i < 3; i++) {
    const taskId = invoke(plane, 'schedule.add_task', { title: `Photo ${i}` })['task_id'] as string;
    const originalSha = stage(plane, randomBytes(400 + i), `photo-${i}.bin`);
    const attach = invoke(plane, 'core.attach', {
      subject_type: 'schedule.task',
      subject_id: taskId,
      staged_sha: originalSha,
    });
    originals.push(originalSha);
    const thumbBytes = randomBytes(64 + i);
    const thumbSha = stage(plane, thumbBytes, `photo-${i}.thumb`);
    plane.db.vault
      .prepare(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'thumb', ?, 'image/webp', ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        attach['content_id'] as string,
        thumbSha,
        thumbBytes.length,
        new Date().toISOString(),
      );
  }
  seedSealedOutbox(plane);

  // Believe originals[0]+[1] durable on the remote cas tier, and make it true by
  // seeding the provider's attested cas store (so lazy defers them).
  const replica = new ReplicaIndex(plane.db.vault);
  replica.mark(originals[0]!, 400, 'cas');
  replica.mark(originals[1]!, 401, 'cas');

  // Remote-primary settings ride into the snapshot, so the recovered vault has a
  // resolvable remote tier (see `declareRemotePrimary`).
  declareRemotePrimary(plane);

  const vaultIds = [vaultId];
  if (includeSecondVault) {
    const second = registry.create('Archive');
    const secondPlane = registry.get(second.vaultId)!;
    seedSealedOutbox(secondPlane);
    declareRemotePrimary(secondPlane);
    invoke(secondPlane, 'schedule.add_task', { title: 'Second vault row' });
    vaultIds.push(second.vaultId);
  }

  await service.runAll();
  const status = await service.status();
  const targetId = status[vaultId]!.targetId;
  const kitDocument = await service.recoveryKitDocument();

  const casProvider = openRemoteBackupProvider({ baseUrl: server.url, apiKey: server.apiKey });
  const casStore = await casProvider.openDataPlane(targetId, 'cas', 'read-write');
  for (const sha of [originals[0]!, originals[1]!]) {
    await casStore.put(`blobs/sha256/${sha}`, new Uint8Array(Buffer.from(`remote-${sha}`)));
  }

  return {
    vaultId,
    vaultIds,
    targetId,
    kitDocument,
    apiKey: server.apiKey,
    serverUrl: server.url,
  };
}

test('a zero-vault gateway restores through one founding capability and enrolls the proved owner', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server);

  // Mint the host-possession capability before the daemon takes the exclusive
  // gateway.db lock, then boot with exactly zero vaults.
  const dataDir = await tempDir('recover-live-gw');
  const database = GatewayDatabase.open(dataDir);
  const minted = PairingTicketStore.open(database).mintFounding(FOUNDING_TICKET_TTL_MS);
  database.close();
  const ticket = encodePairingTicket({
    v: 1,
    kind: 'centraid-gw-found',
    gw: 'test-gateway-ticket',
    t: minted.ticketId,
    s: minted.secret,
    exp: minted.expiresAt,
  });
  const handle: GatewayServeHandle = await serve({
    paths: { vaultDir: path.join(dataDir, 'vault') },
    deviceAccess: {
      deviceKeyFor: (req) =>
        typeof req.headers['x-test-endpoint'] === 'string'
          ? req.headers['x-test-endpoint']
          : undefined,
      vaultsFor: () => [],
    },
  });
  cleanups.push(() => handle.close());
  expect(handle.vaults.isFresh()).toBe(true);

  const restored = await fetch(`${handle.url}/centraid/_vault/vaults:restore`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${handle.token}`,
      'content-type': 'application/json',
      'x-test-endpoint': 'founder-device',
    },
    body: JSON.stringify({
      ticket,
      password: 'recovery-test-password',
      kit: a.kitDocument,
      apiKey: a.apiKey,
      deviceName: 'Owner laptop',
      platform: 'desktop',
    }),
  });
  expect(restored.status).toBe(201);
  const response = (await restored.json()) as {
    report: {
      vaultId: string;
      previews: { warmed: boolean; timeToUsableGridMs?: number };
    };
    enrollment: { endpointId: string; trust: string };
  };
  expect(response.report.vaultId).toBe(a.vaultId);
  expect(response.enrollment).toMatchObject({
    endpointId: 'founder-device',
    trust: 'owner',
  });

  // LIVE integration: the recovered vault is the only mounted vault and the
  // quarantine fired before ordinary use.
  expect(handle.vaults.get(a.vaultId)).toBeTruthy();
  expect(handle.vaults.defaultVaultId()).toBe(a.vaultId);
  expect(handle.vaults.list()).toHaveLength(1);
  expect(handle.vaults.isFresh()).toBe(false);
  const mountedPlane = handle.vaults.get(a.vaultId)!;
  expect(mountedPlane.quarantine).not.toBeNull();
  expect(mountedPlane.quarantine!.outboxParked).toBeGreaterThanOrEqual(1);

  expect(response.report.previews).toMatchObject({ warmed: expect.any(Boolean) });

  // A second recovery is refused — the gateway is no longer fresh.
  const again = await fetch(`${handle.url}/centraid/_vault/vaults:restore`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${handle.token}`,
      'content-type': 'application/json',
      'x-test-endpoint': 'founder-device',
    },
    body: JSON.stringify({
      ticket,
      password: 'recovery-test-password',
      kit: a.kitDocument,
      apiKey: a.apiKey,
    }),
  });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: string }).error).toBe('already_initialized');
}, 60_000);

test('one founding restore adopts every backed-up vault and enrolls the owner in each', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server, true);
  expect(a.vaultIds).toHaveLength(2);

  const dataDir = await tempDir('recover-live-multi-gw');
  const database = GatewayDatabase.open(dataDir);
  const minted = PairingTicketStore.open(database).mintFounding(FOUNDING_TICKET_TTL_MS);
  database.close();
  const ticket = encodePairingTicket({
    v: 1,
    kind: 'centraid-gw-found',
    gw: 'test-gateway-ticket',
    t: minted.ticketId,
    s: minted.secret,
    exp: minted.expiresAt,
  });
  const handle = await serve({
    paths: { vaultDir: path.join(dataDir, 'vault') },
    deviceAccess: {
      deviceKeyFor: (req) =>
        typeof req.headers['x-test-endpoint'] === 'string'
          ? req.headers['x-test-endpoint']
          : undefined,
      vaultsFor: () => [],
    },
  });
  cleanups.push(() => handle.close());

  const restored = await fetch(`${handle.url}/centraid/_vault/vaults:restore`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${handle.token}`,
      'content-type': 'application/json',
      'x-test-endpoint': 'multi-founder',
    },
    body: JSON.stringify({
      ticket,
      password: 'recovery-test-password',
      kit: a.kitDocument,
      apiKey: a.apiKey,
      deviceName: 'Owner phone',
      platform: 'mobile',
    }),
  });
  expect(restored.status).toBe(201);
  const body = (await restored.json()) as {
    reports: Array<{ vaultId: string }>;
    enrollments: Array<{ vaultId: string; endpointId: string; trust: string }>;
  };
  expect(body.reports.map((report) => report.vaultId).sort()).toEqual(a.vaultIds.toSorted());
  expect(body.enrollments).toHaveLength(2);
  expect(body.enrollments).toEqual(
    expect.arrayContaining(
      a.vaultIds.map((vaultId) =>
        expect.objectContaining({
          vaultId,
          endpointId: 'multi-founder',
          trust: 'owner',
        }),
      ),
    ),
  );
  const keys = new KeyStore(path.join(dataDir, 'keys'));
  for (const vaultId of a.vaultIds) {
    expect(handle.vaults.get(vaultId)).toBeTruthy();
    expect(keys.export(`${vaultId}.sealkey`)).toHaveLength(32);
  }
}, 90_000);

test('erase then restore on the same box preserves gateway identity and drops prior enrollments', async () => {
  const provider = await startFakeProviderServer();
  cleanups.push(() => provider.close());
  const dataDir = await tempDir('erase-restore-same-box-');
  const paths = {
    vaultDir: path.join(dataDir, 'vault'),
  };
  const backup = {
    enabled: true as const,
    provider: {
      kind: 'remote' as const,
      endpoint: provider.url,
      apiKey: provider.apiKey,
    },
  };
  const hostEndpointId = 'a'.repeat(64);
  let handle = await serve({
    paths,
    backup,
    initVaultName: 'Family',
    hostDeviceEndpointId: hostEndpointId,
  });
  const vaultId = handle.vaults.defaultVaultId();
  seedSealedOutbox(handle.vaults.get(vaultId)!);
  await handle.backup!.runBackup(vaultId);
  const kit = await handle.backup!.recoveryKitDocument();
  await handle.backup!.verifyRecoveryKit({
    kit: wrapRecoveryKit(kit, 'test-password'),
    password: 'test-password',
    lossConsent: true,
  });
  const keys = new KeyStore(path.join(dataDir, 'keys'));
  const endpointBefore = keys.export('endpoint-key.bin');

  const erased = await fetch(`${handle.url}/centraid/_vault/vaults:erase`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${handle.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'Family' }),
  });
  expect(erased.status).toBe(200);
  expect(handle.vaults.isFresh()).toBe(true);
  await handle.close();

  const database = GatewayDatabase.open(dataDir);
  expect(database.db.prepare('SELECT COUNT(*) AS count FROM devices').get()).toEqual({ count: 0 });
  const minted = PairingTicketStore.open(database).mintFounding(FOUNDING_TICKET_TTL_MS);
  database.close();
  const ticket = encodePairingTicket({
    v: 1,
    kind: 'centraid-gw-found',
    gw: 'same-box-ticket',
    t: minted.ticketId,
    s: minted.secret,
    exp: minted.expiresAt,
  });

  handle = await serve({ paths, backup, hostDeviceEndpointId: hostEndpointId });
  cleanups.push(() => handle.close());
  const rePair = await fetch(`${handle.url}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${handle.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ vaultId }),
  });
  expect(rePair.status).toBe(409);
  expect(await rePair.json()).toMatchObject({ error: 'uninitialized' });

  const restored = await fetch(`${handle.url}/centraid/_vault/vaults:restore`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${handle.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ticket,
      kit,
      password: 'plain-kit-compatibility',
      apiKey: provider.apiKey,
      deviceName: 'Same laptop',
      platform: 'desktop',
    }),
  });
  const restoredBody = (await restored.json()) as Record<string, unknown>;
  expect(restored.status, JSON.stringify(restoredBody)).toBe(201);
  expect(handle.vaults.get(vaultId)).toBeTruthy();
  expect(keys.export('endpoint-key.bin')).toEqual(endpointBefore);
}, 90_000);
