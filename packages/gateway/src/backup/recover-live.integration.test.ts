import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * The LIVE-gateway recovery e2e (issue #439 R1 wave 4) — the pre-vault recover
 * routes, the daemon-owned job, and the progress SSE driven end-to-end against a
 * REAL `serve()` gateway and the fake HTTP provider. Where `recover-e2e.test.ts`
 * calls the `recover()` verb directly, this proves the whole product surface: a
 * fresh gateway (empty root, one auto-created pristine default) validates a kit,
 * shows the found-your-vault card, starts the daemon job past the metered-egress
 * confirm, and streams progress to `event: end`. Then it asserts the LIVE
 * integration the CLI shell cannot reach: the recovered vault is MOUNTED and
 * becomes the effective default (the pristine default was adopted away), the
 * restore quarantine fired on first mount, and — because the live gateway
 * satisfies `resolveRemoteTier` with the mounted plane's own `db.remote()` — the
 * previews-first warm pass ran and `timeToUsableGridMs` landed in the report.
 */

import { afterEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import crypto, { randomBytes } from 'node:crypto';
import { openRemoteBackupProvider } from '@centraid/backup';
import { startFakeProviderServer } from '@centraid/backup/dist/testing/fake-provider-server.js';
import { ReplicaIndex } from '@centraid/vault';
import { openVaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { serve, type GatewayServeHandle } from '../serve/serve.js';
import { BackupService } from './backup-service.js';

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
  targetId: string;
  kitDocument: Record<string, unknown>;
  apiKey: string;
  serverUrl: string;
}

async function seedMachineA(
  server: Awaited<ReturnType<typeof startFakeProviderServer>>,
): Promise<MachineA> {
  const registry = openVaultRegistry({
    rootDir: await tempDir('recover-live-a'),
    logger: silentLogger,
    ownerName: 'Mara',
  });
  cleanups.push(() => registry.stop());
  const vaultId = registry.defaultVaultId();
  const plane = registry.get(vaultId)!;
  const service = new BackupService({
    config: {
      enabled: true,
      provider: { kind: 'remote', endpoint: server.url, apiKey: server.apiKey },
    },
    backupDir: await tempDir('recover-live-a-backup'),
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

  await service.runBackup(vaultId);
  const status = await service.status();
  const targetId = status[vaultId]!.targetId;
  const kitDocument = (await service.recoveryKitDocument()) as Record<string, unknown>;

  const casProvider = openRemoteBackupProvider({ baseUrl: server.url, apiKey: server.apiKey });
  const casStore = await casProvider.openDataPlane(targetId, 'cas', 'read-write');
  for (const sha of [originals[0]!, originals[1]!]) {
    await casStore.put(`blobs/sha256/${sha}`, new Uint8Array(Buffer.from(`remote-${sha}`)));
  }

  return { vaultId, targetId, kitDocument, apiKey: server.apiKey, serverUrl: server.url };
}

test('a fresh gateway recovers a vault over the live routes: kit → discover → start → SSE, then MOUNTED + quarantined + previews warmed', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server);

  // A brand-new gateway daemon: empty data dir, one auto-created pristine default.
  const dataDir = await tempDir('recover-live-gw');
  const handle: GatewayServeHandle = await serve({
    paths: { vaultDir: path.join(dataDir, 'vault'), prefsFile: path.join(dataDir, 'prefs.json') },
  });
  cleanups.push(() => handle.close());
  const auth = { Authorization: `Bearer ${handle.token}` };
  const url = (p: string): string => `${handle.url}/centraid/_gateway/recover${p}`;

  // 1. The gateway is fresh, and validates the kit into a sanitized summary.
  const kitRes = await fetch(url('/kit'), {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(a.kitDocument),
  });
  expect(kitRes.status).toBe(200);

  const statusBefore = (await (await fetch(url('/status'), { headers: auth })).json()) as {
    fresh: boolean;
    job: null;
  };
  expect(statusBefore).toEqual({ fresh: true, job: null });

  // 2. The found-your-vault card — metered egress, compatible.
  const discover = (await (
    await fetch(url('/discover'), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kit: a.kitDocument, apiKey: a.apiKey }),
    })
  ).json()) as { found: boolean; restoreCostClass: string; vaultId: string };
  expect(discover).toMatchObject({
    found: true,
    restoreCostClass: 'metered-egress',
    vaultId: a.vaultId,
  });

  // 3. Start the daemon job — metered, so the confirm is required.
  const started = await fetch(url('/start'), {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ kit: a.kitDocument, apiKey: a.apiKey, confirmed: true }),
  });
  expect(started.status).toBe(202);
  const { jobId } = (await started.json()) as { jobId: string };

  // 4. Stream progress to `event: end`, capturing the final report frame.
  const stream = await fetch(url(`/events?job=${jobId}`), { headers: auth });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    if (buf.includes('event: end') || done) break;
  }
  expect(buf).toMatch(/event: end\ndata: \{"state":"done"\}/);
  const reportFrame = /event: report\ndata: (\{[\s\S]*?\})\n\n/.exec(buf);
  const report = JSON.parse(reportFrame![1]!) as {
    vaultId: string;
    previews: { warmed: boolean; timeToUsableGridMs?: number };
  };
  expect(report.vaultId).toBe(a.vaultId);

  // 5. LIVE integration: the recovered vault is mounted and is now the default,
  //    the pristine bootstrap default was adopted away, and the quarantine fired.
  expect(handle.vaults.get(a.vaultId)).toBeTruthy();
  expect(handle.vaults.defaultVaultId()).toBe(a.vaultId);
  expect(handle.vaults.list()).toHaveLength(1);
  expect(handle.vaults.isFresh()).toBe(false);
  const mountedPlane = handle.vaults.get(a.vaultId)!;
  expect(mountedPlane.quarantine).not.toBeNull();
  expect(mountedPlane.quarantine!.outboxParked).toBeGreaterThanOrEqual(1);

  // 6. The gateway satisfied `resolveRemoteTier` (the mounted plane's own
  //    `db.remote()`), so the previews-first warm pass ran in-process.
  expect(report.previews.warmed).toBe(true);
  expect(typeof report.previews.timeToUsableGridMs).toBe('number');

  // 7. A second recovery is refused — the gateway is no longer fresh.
  const again = await fetch(url('/start'), {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ kit: a.kitDocument, apiKey: a.apiKey, confirmed: true }),
  });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: string }).error).toBe('not_fresh');
}, 60_000);
