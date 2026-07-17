/*
 * HTTP-level coverage for the pre-vault recovery routes (issue #439 R1 wave 4).
 * A minimal "machine A" is seeded and backed up against the REAL fake HTTP
 * provider so `/recover/kit` + `/recover/discover` run against genuine kit +
 * provider bytes; the daemon job's `recover()` is a DETERMINISTIC stand-in
 * (injected `recoverFn`) so `/recover/start`, the gates, and the progress SSE
 * are driven without a real restore (the real integration is `recover-live-
 * e2e.test.ts`). Covers: kit validate good/bad; discover found / incompatible /
 * wrong-key; the start gates (metered without confirm ⇒ 409 with estimate,
 * non-fresh gateway ⇒ 409, double-start ⇒ 409); status; the admin-plane gate;
 * and the SSE replay-then-live-through-`end` stream.
 */

import { afterEach, expect, test } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { openRemoteBackupProvider, SNAPSHOT_FORMAT } from '@centraid/backup';
import { startFakeProviderServer } from '@centraid/backup/dist/testing/fake-provider-server.js';
import { AUTHED_DEVICE_HEADER } from '@centraid/app-engine';
import type { RouteHandler } from '../serve/build-gateway.js';
import { openVaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { BackupService } from '../backup/backup-service.js';
import { RecoverJobRunner, type RecoverJobDeps } from '../backup/recover-job.js';
import type { RecoverReport } from '../backup/recover.js';
import { makeRecoverRouteHandler } from './recover-routes.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const servers: http.Server[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function startHandlerServer(handler: RouteHandler): Promise<string> {
  const server = http.createServer((req, res) => {
    void handler(req, res).then((owned) => {
      if (!owned) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function invoke(plane: VaultPlane, command: string, input: Record<string, unknown>): void {
  const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
  if (out.status !== 'executed') throw new Error(`${command} failed: ${JSON.stringify(out)}`);
}

interface MachineA {
  vaultId: string;
  targetId: string;
  oldGeneration: number;
  kitDocument: Record<string, unknown>;
  apiKey: string;
  serverUrl: string;
}

/** Seed a real vault + one backup against the fake provider; return the kit. */
async function seedMachineA(
  server: Awaited<ReturnType<typeof startFakeProviderServer>>,
): Promise<MachineA> {
  const registry = openVaultRegistry({
    rootDir: await tempDir('recover-routes-a'),
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
    backupDir: await tempDir('recover-routes-a-backup'),
    vaults: registry,
    health: new HealthRegistry(),
    logger: silentLogger,
  });
  cleanups.push(() => service.stop());
  invoke(plane, 'schedule.add_task', { title: 'A task' });
  await service.runBackup(vaultId);
  const status = await service.status();
  return {
    vaultId,
    targetId: status[vaultId]!.targetId,
    oldGeneration: status[vaultId]!.generation,
    kitDocument: (await service.recoveryKitDocument()) as Record<string, unknown>,
    apiKey: server.apiKey,
    serverUrl: server.url,
  };
}

function report(vaultId: string, targetId: string): RecoverReport {
  return {
    vaultId,
    targetId,
    provider: 'https://home.example',
    vaultDir: `/tmp/${vaultId}`,
    seq: 1,
    generation: 2,
    recoveredAsOf: 1_700_000_000_000,
    truncated: false,
    skippedBlobs: 0,
    inventoryConsulted: true,
    restoreCostClass: 'metered-egress',
    previews: { warmed: false, reason: 'headless' },
    reconcile: { checked: 0, missing: 0, repinned: [], lost: [] },
    quarantine: ['outbox'],
  };
}

/** A route handler + its job runner, with the recovery verb stubbed. `fresh`
 *  is a mutable box so a test can flip the gateway non-fresh. */
async function makeRoutes(
  a: MachineA,
  over: Partial<RecoverJobDeps> = {},
): Promise<{ base: string; job: RecoverJobRunner; fresh: { value: boolean } }> {
  const fresh = { value: true };
  const job = new RecoverJobRunner({
    dir: await tempDir('recover-routes-job'),
    vaultRoot: await tempDir('recover-routes-job-vaults'),
    backupDir: await tempDir('recover-routes-job-backup'),
    adopt: () => undefined,
    resolveRemoteTier: () => undefined,
    logger: silentLogger,
    recoverFn: async (input) => {
      input.onPhase?.('discovering');
      input.onPhase?.('fetching');
      input.onPhase?.('done');
      return report(a.vaultId, a.targetId);
    },
    ...over,
  });
  cleanups.push(() => job.flush());
  const handler = makeRecoverRouteHandler({ job, isFresh: () => fresh.value });
  const base = await startHandlerServer(handler);
  return { base, job, fresh };
}

const url = (base: string, p: string): string => `${base}/centraid/_gateway/recover${p}`;

test('POST /recover/kit validates a kit and returns a sanitized summary (never the keyring)', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server);
  const { base } = await makeRoutes(a);

  const ok = await fetch(url(base, '/kit'), {
    method: 'POST',
    body: JSON.stringify(a.kitDocument),
  });
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { ok: boolean; targets: Array<{ vaultId: string }> };
  expect(body.ok).toBe(true);
  expect(body.targets.some((t) => t.vaultId === a.vaultId)).toBe(true);
  // The keyring never rides back.
  expect(JSON.stringify(body)).not.toContain('keyring');

  const bad = await fetch(url(base, '/kit'), {
    method: 'POST',
    body: JSON.stringify({ not: 'a kit' }),
  });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe('invalid_kit');
});

test('POST /recover/discover: found / wrong-key / incompatible', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server);
  const { base } = await makeRoutes(a);

  // Found: the metered-egress facts card.
  const found = await fetch(url(base, '/discover'), {
    method: 'POST',
    body: JSON.stringify({ kit: a.kitDocument, apiKey: a.apiKey }),
  });
  expect(found.status).toBe(200);
  const card = (await found.json()) as {
    found: boolean;
    restoreCostClass: string;
    compatible: boolean;
    sizeBytes: number;
    vaultId: string;
  };
  expect(card).toMatchObject({ found: true, compatible: true, restoreCostClass: 'metered-egress' });
  expect(card.vaultId).toBe(a.vaultId);

  // Wrong key: the provider auth error passes its status through.
  const wrong = await fetch(url(base, '/discover'), {
    method: 'POST',
    body: JSON.stringify({ kit: a.kitDocument, apiKey: 'sk-wrong' }),
  });
  expect(wrong.status).toBe(401);

  // Incompatible: a snapshot written by newer software becomes the newest row.
  await openRemoteBackupProvider({ baseUrl: a.serverUrl, apiKey: a.apiKey }).registerSnapshot(
    a.targetId,
    {
      idempotencyKey: 'from-the-future',
      manifestKey: `u/${a.targetId}/backup/manifests/future.json`,
      manifestHash: 'c'.repeat(64),
      totalBytes: 0,
      objectCount: 0,
      generation: a.oldGeneration,
      format: SNAPSHOT_FORMAT,
      appMeta: { vaultUserVersion: '9999', ontologyVersion: '1.0' },
    },
  );
  const incompat = await fetch(url(base, '/discover'), {
    method: 'POST',
    body: JSON.stringify({ kit: a.kitDocument, apiKey: a.apiKey }),
  });
  expect(incompat.status).toBe(409);
  expect(((await incompat.json()) as { error: string }).error).toBe('incompatible');
});

test('POST /recover/start gates: metered-without-confirm, non-fresh, and double-start all 409', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server);

  // Metered egress + no confirm ⇒ 409 with the estimate.
  const { base } = await makeRoutes(a);
  const gated = await fetch(url(base, '/start'), {
    method: 'POST',
    body: JSON.stringify({ kit: a.kitDocument, apiKey: a.apiKey }),
  });
  expect(gated.status).toBe(409);
  const gatedBody = (await gated.json()) as {
    error: string;
    estimate: { restoreCostClass: string };
  };
  expect(gatedBody.error).toBe('confirm_required');
  expect(gatedBody.estimate.restoreCostClass).toBe('metered-egress');

  // Non-fresh gateway ⇒ 409 before the provider is even dialed.
  const nf = await makeRoutes(a);
  nf.fresh.value = false;
  const notFresh = await fetch(url(nf.base, '/start'), {
    method: 'POST',
    body: JSON.stringify({ kit: a.kitDocument, apiKey: a.apiKey, confirmed: true }),
  });
  expect(notFresh.status).toBe(409);
  expect(((await notFresh.json()) as { error: string }).error).toBe('not_fresh');

  // Confirmed start succeeds; a second start while it runs ⇒ 409 recover_in_progress.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ds = await makeRoutes(a, {
    recoverFn: async (input) => {
      input.onPhase?.('discovering');
      await gate;
      return report(a.vaultId, a.targetId);
    },
  });
  const first = await fetch(url(ds.base, '/start'), {
    method: 'POST',
    body: JSON.stringify({ kit: a.kitDocument, apiKey: a.apiKey, confirmed: true }),
  });
  expect(first.status).toBe(202);
  const { jobId } = (await first.json()) as { jobId: string };
  expect(jobId).toBeTruthy();
  const second = await fetch(url(ds.base, '/start'), {
    method: 'POST',
    body: JSON.stringify({ kit: a.kitDocument, apiKey: a.apiKey, confirmed: true }),
  });
  expect(second.status).toBe(409);
  expect(((await second.json()) as { error: string }).error).toBe('recover_in_progress');
  release();
});

test('GET /recover/status folds fresh + the job record; admin-plane only', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server);
  const { base } = await makeRoutes(a);

  const status = await fetch(url(base, '/status'));
  expect(status.status).toBe(200);
  expect((await status.json()) as { fresh: boolean; job: null }).toEqual({
    fresh: true,
    job: null,
  });

  // A paired-device token (the authed-device header) is refused — recovery is
  // the owner's act.
  const asDevice = await fetch(url(base, '/status'), {
    headers: { [AUTHED_DEVICE_HEADER]: 'http:some-device' },
  });
  expect(asDevice.status).toBe(403);
  expect(((await asDevice.json()) as { error: string }).error).toBe('admin_only');
});

test('GET /recover/events streams replay-then-live phases and a final report through end', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const a = await seedMachineA(server);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { base } = await makeRoutes(a, {
    recoverFn: async (input) => {
      input.onPhase?.('discovering');
      input.onPhase?.('fetching');
      await gate; // stays running so the SSE opens mid-flight
      input.onPhase?.('adopting');
      input.onPhase?.('done');
      return report(a.vaultId, a.targetId);
    },
  });

  const started = await fetch(url(base, '/start'), {
    method: 'POST',
    body: JSON.stringify({ kit: a.kitDocument, apiKey: a.apiKey, confirmed: true }),
  });
  const { jobId } = (await started.json()) as { jobId: string };
  // Let the two pre-gate phases emit before we attach.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const stream = await fetch(url(base, `/events?job=${jobId}`));
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const readUntilEnd = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (buf.includes('event: end')) return;
      if (done) return;
    }
  };
  // First drain replays the two phases already emitted, then release the job so
  // the remaining phases + the report arrive live.
  release();
  await readUntilEnd();

  // Phase frames arrived in order (replay: discovering, fetching; live:
  // adopting, done), a report frame carried the completion, and the stream
  // closed with a terminal `end` naming the done state.
  const phases = [...buf.matchAll(/event: phase\ndata: (\{[^\n]*\})/g)].map(
    (m) => (JSON.parse(m[1]!) as { phase: string }).phase,
  );
  expect(phases).toEqual(['discovering', 'fetching', 'adopting', 'done']);
  expect(buf).toContain('event: report');
  const reportFrame = /event: report\ndata: (\{[\s\S]*?\})\n\n/.exec(buf);
  expect((JSON.parse(reportFrame![1]!) as { vaultId: string }).vaultId).toBe(a.vaultId);
  expect(buf).toContain('event: end');
  expect(buf).toMatch(/event: end\ndata: \{"state":"done"\}/);
});
