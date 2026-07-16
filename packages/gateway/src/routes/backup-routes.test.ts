import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { BackupService } from '../backup/backup-service.js';
import type { BackupTargetState } from '../backup/backup-state.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { makeBackupRouteHandler, type BackupStatusBody } from './backup-routes.js';
import { bootstrapVault, openVaultDb } from '@centraid/vault';

/** Loosened GET-body shape for tests that only assert a slice of it. */
type BackupStatusBodyForTest = Pick<BackupStatusBody, 'recoveryKit'>;

const servers: http.Server[] = [];
const vaultDbs: ReturnType<typeof openVaultDb>[] = [];

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

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const db of vaultDbs.splice(0)) db.close();
  vi.restoreAllMocks();
});

/** A `VaultRegistry` stand-in with real in-memory policy/custody tables. */
function fakeVaults(planes: Array<{ vaultId: string; name: string }>): VaultRegistry {
  const mounted = planes.map((p) => {
    const db = openVaultDb();
    bootstrapVault(db, { ownerName: 'Test Owner', vaultId: p.vaultId });
    vaultDbs.push(db);
    return {
      boot: { vaultId: p.vaultId },
      name: p.name,
      db,
      rescheduleWalCapture: () => undefined,
    };
  });
  return {
    planesList: () => mounted,
    get: (vaultId: string) => mounted.find((plane) => plane.boot.vaultId === vaultId),
  } as unknown as VaultRegistry;
}

/** A `BackupService` stand-in with controllable `status`/`isRunning`/`runAll`/
 *  recovery-kit methods — deterministic in a way a real service's timing
 *  isn't (e.g. the "already running" race). */
function fakeBackupService(opts: {
  targets?: Record<string, BackupTargetState>;
  running?: Set<string> | boolean;
  runAll?: () => Promise<void>;
  verifyAll?: () => Promise<void>;
  recoveryKitDocument?: () => Promise<Record<string, unknown>>;
  recoveryKitConfirmedAt?: number | null;
}): BackupService {
  const targets = opts.targets ?? {};
  const running = opts.running ?? false;
  let confirmedAt = opts.recoveryKitConfirmedAt ?? null;
  return {
    status: async () => targets,
    isRunning: (vaultId?: string) => {
      if (typeof running === 'boolean') return running;
      return vaultId === undefined ? running.size > 0 : running.has(vaultId);
    },
    runAll: opts.runAll ?? (async () => undefined),
    verifyAll: opts.verifyAll ?? (async () => undefined),
    recoveryKitDocument:
      opts.recoveryKitDocument ??
      (async () => ({ version: 1, kind: 'centraid-recovery-kit', targets: [] })),
    recoveryKitStatus: async () => ({ confirmedAt }),
    confirmRecoveryKit: async () => {
      confirmedAt = 1_752_235_200; // fixed stub "now" — the route just echoes it back
      return { confirmedAt };
    },
  } as unknown as BackupService;
}

describe('makeBackupRouteHandler — GET /centraid/_gateway/backup', () => {
  it('reports mounted local-only vault status when no BackupService is wired', async () => {
    const url = await startHandlerServer(
      makeBackupRouteHandler({ vaults: fakeVaults([{ vaultId: 'v1', name: 'Main' }]) }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: false,
      vaults: [
        {
          vaultId: 'v1',
          name: 'Main',
          destination: { kind: 'gateway-local' },
          pendingOffsite: { count: 0, bytes: 0 },
          running: false,
        },
      ],
      recoveryKit: { confirmedAt: null },
    });
  });

  it('reports per-vault status when configured, merging state onto every mounted vault', async () => {
    const backupService = fakeBackupService({
      targets: {
        v1: {
          targetId: 't1',
          label: 'abc',
          generation: 1,
          lastBackupAt: '2026-07-10T00:00:00.000Z',
          lastVerifiedAt: '2026-07-09T00:00:00.000Z',
        },
      },
      running: new Set(['v2']),
    });
    const url = await startHandlerServer(
      makeBackupRouteHandler({
        backupService,
        vaults: fakeVaults([
          { vaultId: 'v1', name: 'Main' },
          { vaultId: 'v2', name: 'Side' },
        ]),
      }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      vaults: Array<{
        vaultId: string;
        name?: string;
        lastBackupAt?: string;
        lastVerifyAt?: string;
        lastError?: string;
        running?: boolean;
      }>;
    };
    expect(body.configured).toBe(true);
    expect(body.vaults).toMatchObject([
      {
        vaultId: 'v1',
        name: 'Main',
        lastBackupAt: '2026-07-10T00:00:00.000Z',
        lastVerifyAt: '2026-07-09T00:00:00.000Z',
        running: false,
      },
      { vaultId: 'v2', name: 'Side', running: true },
    ]);
  });

  it('surfaces lastError for a fenced/failed vault without dropping it from the list', async () => {
    const backupService = fakeBackupService({
      targets: {
        v1: {
          targetId: 't1',
          label: 'abc',
          generation: 1,
          lastError: 'another machine has taken over this vault (conflict_generation)',
        },
      },
    });
    const url = await startHandlerServer(
      makeBackupRouteHandler({
        backupService,
        vaults: fakeVaults([{ vaultId: 'v1', name: 'Main' }]),
      }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup`);
    const body = (await res.json()) as { vaults: Array<{ lastError?: string }> };
    expect(body.vaults[0]?.lastError).toMatch(/conflict_generation/);
  });

  it('answers 405 for non-GET', async () => {
    const url = await startHandlerServer(makeBackupRouteHandler({ vaults: fakeVaults([]) }));
    const res = await fetch(`${url}/centraid/_gateway/backup`, { method: 'POST' });
    // POST is a distinct sub-route (`/backup/run`) — POSTing the status
    // path itself is method_not_allowed, not routed to `run`.
    expect(res.status).toBe(405);
  });

  it('ignores unrelated paths (returns false → server 404)', async () => {
    const url = await startHandlerServer(makeBackupRouteHandler({ vaults: fakeVaults([]) }));
    const res = await fetch(`${url}/centraid/_gateway/health`);
    expect(res.status).toBe(404);
  });
});

describe('makeBackupRouteHandler — POST /centraid/_gateway/backup/run', () => {
  it('refuses with 409 + a clear body when not configured', async () => {
    const url = await startHandlerServer(makeBackupRouteHandler({ vaults: fakeVaults([]) }));
    const res = await fetch(`${url}/centraid/_gateway/backup/run`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('not_configured');
    expect(body.message).toMatch(/not configured/);
  });

  it('triggers runAll() and answers 202 immediately without waiting for it to finish', async () => {
    let resolveRun: () => void = () => undefined;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const runAll = vi.fn(() => runPromise);
    const backupService = fakeBackupService({ runAll });
    const url = await startHandlerServer(
      makeBackupRouteHandler({
        backupService,
        vaults: fakeVaults([{ vaultId: 'v1', name: 'Main' }]),
      }),
    );

    const res = await fetch(`${url}/centraid/_gateway/backup/run`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(runAll).toHaveBeenCalledTimes(1);
    resolveRun();
  });

  it('answers alreadyRunning without calling runAll() again while one is in flight', async () => {
    const runAll = vi.fn(async () => undefined);
    const backupService = fakeBackupService({ running: true, runAll });
    const url = await startHandlerServer(
      makeBackupRouteHandler({
        backupService,
        vaults: fakeVaults([{ vaultId: 'v1', name: 'Main' }]),
      }),
    );

    const res = await fetch(`${url}/centraid/_gateway/backup/run`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, alreadyRunning: true });
    expect(runAll).not.toHaveBeenCalled();
  });

  it('answers 405 for non-POST', async () => {
    const backupService = fakeBackupService({});
    const url = await startHandlerServer(
      makeBackupRouteHandler({ backupService, vaults: fakeVaults([]) }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup/run`);
    expect(res.status).toBe(405);
  });
});

describe('makeBackupRouteHandler — POST /centraid/_gateway/backup/verify', () => {
  it('accepts a manual integrity verification without blocking the response', async () => {
    const verifyAll = vi.fn(async () => undefined);
    const backupService = fakeBackupService({ verifyAll });
    const url = await startHandlerServer(
      makeBackupRouteHandler({ backupService, vaults: fakeVaults([]) }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup/verify`, { method: 'POST' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(verifyAll).toHaveBeenCalledTimes(1);
  });
});

describe('makeBackupRouteHandler — GET /centraid/_gateway/backup/kit', () => {
  it('returns the live recovery document only when a backup service exists', async () => {
    const kit = { version: 1, kind: 'centraid-recovery-kit', targets: [] };
    const backupService = fakeBackupService({ recoveryKitDocument: async () => kit });
    const url = await startHandlerServer(
      makeBackupRouteHandler({ backupService, vaults: fakeVaults([]) }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup/kit`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(kit);
  });
});

describe('makeBackupRouteHandler — GET /centraid/_gateway/backup — recoveryKit', () => {
  it('carries the confirmed-kit timestamp through when set', async () => {
    const backupService = fakeBackupService({ recoveryKitConfirmedAt: 1_752_200_000 });
    const url = await startHandlerServer(
      makeBackupRouteHandler({ backupService, vaults: fakeVaults([]) }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup`);
    const body = (await res.json()) as BackupStatusBodyForTest;
    expect(body.recoveryKit).toEqual({ confirmedAt: 1_752_200_000 });
  });

  it('reports null when the kit has never been confirmed on a configured gateway', async () => {
    const backupService = fakeBackupService({});
    const url = await startHandlerServer(
      makeBackupRouteHandler({ backupService, vaults: fakeVaults([]) }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup`);
    const body = (await res.json()) as BackupStatusBodyForTest;
    expect(body.recoveryKit).toEqual({ confirmedAt: null });
  });
});

describe('makeBackupRouteHandler — POST /centraid/_gateway/backup/kit-confirmed', () => {
  it('refuses with 409 + a clear body when not configured', async () => {
    const url = await startHandlerServer(makeBackupRouteHandler({ vaults: fakeVaults([]) }));
    const res = await fetch(`${url}/centraid/_gateway/backup/kit-confirmed`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('not_configured');
    expect(body.message).toMatch(/not configured/);
  });

  it('confirms the kit and echoes the new confirmedAt', async () => {
    const backupService = fakeBackupService({});
    const url = await startHandlerServer(
      makeBackupRouteHandler({ backupService, vaults: fakeVaults([]) }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup/kit-confirmed`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; confirmedAt: number };
    expect(body.ok).toBe(true);
    expect(body.confirmedAt).toBe(1_752_235_200);

    // The next GET reflects the confirmation.
    const statusRes = await fetch(`${url}/centraid/_gateway/backup`);
    const status = (await statusRes.json()) as BackupStatusBodyForTest;
    expect(status.recoveryKit).toEqual({ confirmedAt: 1_752_235_200 });
  });

  it('answers 405 for non-POST', async () => {
    const backupService = fakeBackupService({});
    const url = await startHandlerServer(
      makeBackupRouteHandler({ backupService, vaults: fakeVaults([]) }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup/kit-confirmed`);
    expect(res.status).toBe(405);
  });

  it('ignores unrelated paths (returns false → server 404)', async () => {
    const url = await startHandlerServer(makeBackupRouteHandler({ vaults: fakeVaults([]) }));
    const res = await fetch(`${url}/centraid/_gateway/health`);
    expect(res.status).toBe(404);
  });
});
