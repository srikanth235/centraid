import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { BackupService } from '../backup/backup-service.js';
import type { BackupTargetState } from '../backup/backup-state.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { makeBackupRouteHandler } from './backup-routes.js';

const servers: http.Server[] = [];

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
  vi.restoreAllMocks();
});

/** A `VaultRegistry` stand-in — `planesList()` is the only surface the
 *  route touches. */
function fakeVaults(planes: Array<{ vaultId: string; name: string }>): VaultRegistry {
  return {
    planesList: () => planes.map((p) => ({ boot: { vaultId: p.vaultId }, name: p.name })),
  } as unknown as VaultRegistry;
}

/** A `BackupService` stand-in with controllable `status`/`isRunning`/`runAll`
 *  — deterministic in a way a real service's timing isn't (e.g. the
 *  "already running" race). */
function fakeBackupService(opts: {
  targets?: Record<string, BackupTargetState>;
  running?: Set<string> | boolean;
  runAll?: () => Promise<void>;
}): BackupService {
  const targets = opts.targets ?? {};
  const running = opts.running ?? false;
  return {
    status: async () => targets,
    isRunning: (vaultId?: string) => {
      if (typeof running === 'boolean') return running;
      return vaultId === undefined ? running.size > 0 : running.has(vaultId);
    },
    runAll: opts.runAll ?? (async () => undefined),
  } as unknown as BackupService;
}

describe('makeBackupRouteHandler — GET /centraid/_gateway/backup', () => {
  it('reports {configured: false, vaults: []} when no BackupService is wired', async () => {
    const url = await startHandlerServer(
      makeBackupRouteHandler({ vaults: fakeVaults([{ vaultId: 'v1', name: 'Main' }]) }),
    );
    const res = await fetch(`${url}/centraid/_gateway/backup`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, vaults: [] });
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
    expect(body.vaults).toEqual([
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
