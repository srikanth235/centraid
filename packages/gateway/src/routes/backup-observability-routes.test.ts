import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { bootstrapVault, openVaultDb, readBackupPolicy } from '@centraid/vault';
import type { BackupService } from '../backup/backup-service.js';
import type { BackupTargetState } from '../backup/backup-state.js';
import { failedReconciliation } from '../backup/backup-reconciliation.js';
import { failedCasOnlyReconciliation } from '../backup/backup-cas-reconciliation.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { makeBackupRouteHandler } from './backup-routes.js';

const opened: ReturnType<typeof openVaultDb>[] = [];
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

function request(url: string, method = 'GET', body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  return Object.assign(req, { url, method }) as unknown as IncomingMessage;
}

function response(): {
  res: ServerResponse;
  result: () => { status: number; body: unknown };
} {
  let raw = '';
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => headers.set(name, value),
    end: (chunk?: string) => {
      raw = chunk ?? '';
    },
  } as unknown as ServerResponse;
  return {
    res,
    result: () => ({ status: res.statusCode, body: raw ? JSON.parse(raw) : undefined }),
  };
}

function harness(target: BackupTargetState | undefined, serviceOver: Partial<BackupService> = {}) {
  const db = openVaultDb();
  bootstrapVault(db, { ownerName: 'Test Owner', vaultId: 'vault-a' });
  opened.push(db);
  const plane = {
    boot: { vaultId: 'vault-a' },
    name: 'Main',
    db,
    rescheduleWalCapture: vi.fn(),
  };
  const vaults = {
    get: (id: string) => (id === 'vault-a' ? plane : undefined),
    planesList: () => [plane],
  } as unknown as VaultRegistry;
  const service = {
    configured: async () => ({ configured: true, provider: 'test-provider' }),
    status: async () => (target ? { 'vault-a': target } : {}),
    recoveryKitStatus: async () => ({ confirmedAt: null }),
    isRunning: () => false,
    ...serviceOver,
  } as unknown as BackupService;
  return { db, plane, handler: makeBackupRouteHandler({ vaults, backupService: service }) };
}

test('backup status exposes persisted policy echo and reconciliation evidence', async () => {
  const reconciliation = failedReconciliation(
    '2026-07-16T00:00:00.000Z',
    'bucket',
    'raw LIST unavailable',
  );
  const target: BackupTargetState = {
    targetId: 'target',
    label: 'opaque',
    generation: 1,
    providerPolicy: {
      status: 'drift',
      desired: {
        rpoSeconds: 60,
        snapshotIntervalHours: 24,
        verifyEveryDays: 7,
        casAck: 'receipt',
      },
      echo: {
        rpoSeconds: 120,
        snapshotIntervalHours: 24,
        verifyEveryDays: 7,
        casAck: 'receipt',
        declaredAt: 1,
      },
      checkedAt: '2026-07-16T00:00:00.000Z',
    },
    reconciliation,
  };
  const { handler } = harness(target);
  const out = response();
  expect(await handler(request('/centraid/_gateway/backup'), out.res)).toBe(true);
  const result = out.result();
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    vaults: [
      {
        vaultId: 'vault-a',
        providerPolicy: { status: 'drift' },
        reconciliation: { status: 'error', mode: 'bucket' },
      },
    ],
  });
});

test('backup status reports durable pending transfer counts and bytes', async () => {
  const target: BackupTargetState = {
    targetId: 'target',
    label: 'opaque',
    generation: 1,
  };
  const { db, handler } = harness(target);
  vi.spyOn(db.blobTransfers, 'status').mockReturnValue({
    pendingCount: 3,
    pendingBytes: 4_096,
    uploadingCount: 1,
    lastError: null,
  });
  const out = response();

  expect(await handler(request('/centraid/_gateway/backup'), out.res)).toBe(true);
  expect(out.result()).toMatchObject({
    status: 200,
    body: { vaults: [{ pendingOffsite: { count: 3, bytes: 4_096 } }] },
  });
});

test('policy update surfaces policy_unmet while retaining the local desired policy', async () => {
  const syncPolicy = vi.fn(async () => ({
    status: 'rejected' as const,
    desired: {
      rpoSeconds: 900,
      snapshotIntervalHours: 24,
      verifyEveryDays: 7,
      casAck: 'receipt' as const,
    },
    checkedAt: '2026-07-16T00:00:00.000Z',
    error: 'provider minimum RPO is one hour',
    errorCode: 'policy_unmet',
  }));
  const target: BackupTargetState = { targetId: 'target', label: 'opaque', generation: 1 };
  const { db, plane, handler } = harness(target, { syncPolicy } as Partial<BackupService>);
  const out = response();
  await handler(
    request('/centraid/_gateway/backup/policy/vault-a', 'PUT', { rpoSeconds: 900 }),
    out.res,
  );
  expect(out.result()).toMatchObject({
    status: 422,
    body: { error: 'policy_unmet', providerPolicy: { status: 'rejected' } },
  });
  expect(readBackupPolicy(db.vault).rpoSeconds).toBe(900);
  expect(plane.rescheduleWalCapture).toHaveBeenCalledOnce();
});

test('verify-against-bucket returns the completed raw cross-check report', async () => {
  const reconciliation = failedReconciliation(
    '2026-07-16T00:00:00.000Z',
    'bucket',
    'provider claimed an object absent from raw LIST',
  );
  const verifyAgainstBucket = vi.fn(async () => reconciliation);
  const target: BackupTargetState = { targetId: 'target', label: 'opaque', generation: 1 };
  const { handler } = harness(target, {
    verifyAgainstBucket,
  } as Partial<BackupService>);
  const out = response();
  await handler(request('/centraid/_gateway/backup/verify-bucket/vault-a', 'POST'), out.res);
  expect(verifyAgainstBucket).toHaveBeenCalledWith('vault-a');
  expect(out.result()).toMatchObject({
    status: 200,
    body: { vaultId: 'vault-a', reconciliation: { mode: 'bucket', status: 'error' } },
  });
});

test('CAS-only status and verify-bucket work when no snapshot backup is configured', async () => {
  const reconciliation = failedCasOnlyReconciliation(
    '2026-07-16T00:00:00.000Z',
    'bucket',
    'authenticated CAS audit failed',
  );
  const verifyAgainstBucket = vi.fn(async () => reconciliation);
  const { handler } = harness(undefined, {
    configured: async () => ({ configured: false }),
    casReconciliationStatus: async () => ({ 'vault-a': reconciliation }),
    verifyAgainstBucket,
  } as Partial<BackupService>);

  const statusOut = response();
  await handler(request('/centraid/_gateway/backup'), statusOut.res);
  expect(statusOut.result()).toMatchObject({
    status: 200,
    body: {
      configured: false,
      vaults: [
        { vaultId: 'vault-a', reconciliation: { status: 'error', cas: { configured: true } } },
      ],
    },
  });

  const verifyOut = response();
  await handler(request('/centraid/_gateway/backup/verify-bucket/vault-a', 'POST'), verifyOut.res);
  expect(verifyAgainstBucket).toHaveBeenCalledWith('vault-a');
  expect(verifyOut.result()).toMatchObject({
    status: 200,
    body: { vaultId: 'vault-a', reconciliation: { status: 'error', mode: 'bucket' } },
  });
});
