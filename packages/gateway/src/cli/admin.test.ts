import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Stopped-daemon filesystem maintenance (issue #289):
 * `centraid-gateway vault|devices|pair` plus the daemon device plane. The
 * tests call the command functions the CLI dispatches to and assert on their
 * stdout and gateway.db rows.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { buildGatewayInfoPayload } from '@centraid/protocol';
import { endpointIdForSecret } from '@centraid/tunnel';
import { KeyStore } from '@centraid/vault';
import { commandVault } from './vault-admin.ts';
import { commandDevices, commandPair } from './device-admin.ts';
import { DEVICE_HEADER, DEVICE_PROOF_HEADER, makeDaemonDevicePlane } from './endpoint-host.ts';
import { daemonLayoutFor } from './paths.ts';
import { openVaultRegistry } from '../serve/vault-registry.ts';
import { EnrollmentStore } from '../serve/enrollment-store.ts';
import { encodePairingTicket, PairingTicketStore } from '../serve/pairing-store.ts';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
// The slowest file in the suite: every test bootstraps a real vault/daemon
// layout on disk, so it is the most fsync-bound thing we run. It needs an
// escalation ABOVE the 30s node-project default in @centraid/test-kit/vitest
// (see the measurements there). Sizing: the slowest single test here measured
// ~5.6s on a fast host; at the ~10x worst observed hosted-runner disk penalty
// that is ~56s, so 60s. The earlier 15s budget blamed v8 coverage
// instrumentation, which was the wrong variable — coverage runs in the ci lane
// too and passes there — and 15s was duly still too small: this file timed out
// twice in nightly run 29733737906 (102s wall for 13 tests vs 20s in ci).
vi.setConfig({ testTimeout: 60_000 });

let dataDir: string;
let out: string[];

/** A `fail` that throws (the CLI exits via `process.exit`); tests assert on it. */
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

/** Capture what a command writes to stdout for the duration of `fn`. */
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
  const joined = chunks.join('');
  out.push(joined);
  return joined;
}

beforeEach(async () => {
  dataDir = await tempDir(`admin-${crypto.randomUUID()}-`);
  out = [];
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function lastJson(text: string): Record<string, unknown> {
  const lines = text.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

async function fakePairDaemon(): Promise<typeof fetch> {
  const layout = daemonLayoutFor(dataDir);
  const secret = Buffer.alloc(32, 7);
  new KeyStore(layout.keysDir).store('endpoint-key.bin', secret);
  const endpointId = endpointIdForSecret(secret);
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
    );
    if (url.pathname === '/centraid/_gateway/info') {
      return Response.json(
        buildGatewayInfoPayload({
          instanceId: 'test-daemon',
          startedAt: Date.now(),
          uptimeMs: 1,
          endpointId,
          endpointTicket: 'gw-ticket-base32',
        }),
      );
    }
    if (url.pathname !== '/centraid/_gateway/devices/ticket') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      vaultId?: string;
      ttlMinutes?: number;
      trust?: 'owner' | 'full' | 'readonly';
    };
    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      logger: silentLogger,
      enableWalShipper: false,
    });
    try {
      const vaults = registry.list();
      const vault =
        vaults.find((row) => row.vaultId === body.vaultId || row.name === body.vaultId) ??
        vaults[0];
      if (!vault) {
        return Response.json(
          {
            error: 'uninitialized',
            message:
              'gateway has no vault yet — run `centraid-gateway init-ticket` and complete founding first',
          },
          { status: 409 },
        );
      }
      if (body.trust === 'owner') {
        return Response.json(
          {
            error: 'invalid_trust',
            message: 'ordinary pairing grants full or readonly trust, never owner',
          },
          { status: 400 },
        );
      }
      const trust = body.trust ?? 'full';
      const minted = PairingTicketStore.open(layout.pairingTicketsFile).mint(
        vault.vaultId,
        (body.ttlMinutes ?? 15) * 60_000,
        trust,
      );
      return Response.json({
        ok: true,
        ticket: encodePairingTicket({
          v: 1,
          kind: 'centraid-gw-pair',
          gw: 'gw-ticket-base32',
          t: minted.ticketId,
          s: minted.secret,
          vaultName: vault.name,
          exp: minted.expiresAt,
        }),
        vaultId: vault.vaultId,
        vaultName: vault.name,
        expiresAt: new Date(minted.expiresAt).toISOString(),
        trust,
      });
    } finally {
      registry.stop();
    }
  }) as typeof fetch;
}

// ── devices admin ─────────────────────────────────────────────────────

test('devices add / list / revoke, scoped by vault', async () => {
  const family = lastJson(
    await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail)),
  );
  const vaultId = family.vaultId as string;

  const added = lastJson(
    await capture(() =>
      commandDevices(
        ['add', '--data-dir', dataDir, 'ep-laptop', '--vault', 'Family', '--label', 'Priya laptop'],
        fail,
      ),
    ),
  );
  expect(added).toMatchObject({ endpointId: 'ep-laptop', vaultId, label: 'Priya laptop' });

  const listed = (
    await capture(() => commandDevices(['list', '--data-dir', dataDir, '--vault', 'Family'], fail))
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  expect(listed).toHaveLength(1);

  const revoked = lastJson(
    await capture(() => commandDevices(['revoke', '--data-dir', dataDir, 'ep-laptop'], fail)),
  );
  expect(revoked).toHaveProperty('revoked');
  // Revoking an unknown device fails loudly.
  await expect(
    capture(() => commandDevices(['revoke', '--data-dir', dataDir, 'ep-gone'], fail)),
  ).rejects.toThrow(/no enrollment/);
});

test('last-owner revoke requires the vault name and SSH can restore an owner', async () => {
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail));
  const owner = lastJson(
    await capture(() =>
      commandDevices(
        ['add', '--data-dir', dataDir, 'ep-owner', '--vault', 'Family', '--trust', 'owner'],
        fail,
      ),
    ),
  );
  const enrollmentId = owner.enrollmentId as string;

  await expect(
    capture(() => commandDevices(['revoke', '--data-dir', dataDir, enrollmentId], fail)),
  ).rejects.toThrow(/last owner.*--confirm-last-owner "Family"/i);

  await capture(() =>
    commandDevices(
      ['revoke', '--data-dir', dataDir, enrollmentId, '--confirm-last-owner', 'Family'],
      fail,
    ),
  );

  const recovered = lastJson(
    await capture(() =>
      commandDevices(
        ['add', '--data-dir', dataDir, 'ep-recovery', '--vault', 'Family', '--trust', 'owner'],
        fail,
      ),
    ),
  );
  expect(recovered).toMatchObject({ endpointId: 'ep-recovery', trust: 'owner' });
});

test('devices admin rejects bad usage + unknown vault', async () => {
  await expect(
    capture(() => commandDevices(['bogus', '--data-dir', dataDir], fail)),
  ).rejects.toThrow(/list, add, revoke/);
  await expect(capture(() => commandDevices(['add', '--data-dir', dataDir], fail))).rejects.toThrow(
    /devices add/,
  );
  await expect(
    capture(() =>
      commandDevices(['add', '--data-dir', dataDir, 'ep-x', '--vault', 'no-such'], fail),
    ),
  ).rejects.toThrow(/no vault named/);
});

// ── pair ──────────────────────────────────────────────────────────────

test('pair needs the daemon endpoint identity, then mints a pasteable ticket', async () => {
  await expect(
    capture(() =>
      commandPair(['--data-dir', dataDir], fail, async () => {
        throw new Error('connection refused');
      }),
    ),
  ).rejects.toThrow(/daemon not running/);

  const layout = daemonLayoutFor(dataDir);
  // Bootstrap a vault the ticket can name.
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail));
  const daemon = await fakePairDaemon();

  const text = await capture(() =>
    commandPair(
      ['--data-dir', dataDir, '--vault', 'Family', '--ttl-minutes', '5', '--trust', 'readonly'],
      fail,
      daemon,
    ),
  );
  expect(text).toMatch(/Pairing ticket for vault "Family"/);
  // The pasteable token is the sole base64url line in the human block.
  const token = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^[A-Za-z0-9_-]{40,}$/.test(l));
  expect(token).toBeTruthy();
  const payload = JSON.parse(Buffer.from(token!, 'base64url').toString('utf8')) as {
    kind: string;
    gw: string;
    vaultName: string;
    t: string;
    s: string;
  };
  expect(payload).toMatchObject({
    kind: 'centraid-gw-pair',
    gw: 'gw-ticket-base32',
    vaultName: 'Family',
  });
  expect(
    PairingTicketStore.open(layout.pairingTicketsFile).redeem(payload.t, payload.s),
  ).toMatchObject({ trust: 'readonly' });
});

test('pair --qr prints a terminal QR of the same pasteable ticket', async () => {
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail));
  const daemon = await fakePairDaemon();

  const text = await capture(() =>
    commandPair(['--data-dir', dataDir, '--vault', 'Family', '--qr'], fail, daemon),
  );
  expect(text).toMatch(/Pairing ticket for vault "Family"/);
  expect(text).toMatch(/Phone: scan this QR/);
  // Token still present and decodable.
  const token = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^[A-Za-z0-9_-]{40,}$/.test(l));
  expect(token).toBeTruthy();
  const payload = JSON.parse(Buffer.from(token!, 'base64url').toString('utf8')) as {
    kind: string;
  };
  expect(payload.kind).toBe('centraid-gw-pair');
  // Terminal QR is multi-line block art.
  expect(text.split('\n').length).toBeGreaterThan(12);
  expect(text).toMatch(/[█▄▀ ]/);
});

test('pair --json emits one JSON line instead of the pasteable text block (issue #382)', async () => {
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail));
  const daemon = await fakePairDaemon();

  const line = await capture(() =>
    commandPair(['--data-dir', dataDir, '--vault', 'Family', '--json'], fail, daemon),
  );
  const parsed = lastJson(line);
  expect(parsed.ok).toBe(true);
  expect(parsed).toHaveProperty('ticket');
  expect(parsed).toHaveProperty('vaultId');
  expect(parsed).toMatchObject({ vaultName: 'Family' });
  expect(typeof parsed.expiresAt).toBe('string');
  // The ticket itself still decodes to the same payload shape as the human path.
  const payload = JSON.parse(
    Buffer.from(parsed.ticket as string, 'base64url').toString('utf8'),
  ) as { kind: string; vaultName: string };
  expect(payload).toMatchObject({ kind: 'centraid-gw-pair', vaultName: 'Family' });
});

test('ordinary pair grants full even for the first device and refuses owner escalation', async () => {
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail));
  const daemon = await fakePairDaemon();

  // Founding is the only path to owner. Ordinary pairing is never sensitive
  // to whether this happens to be the first enrollment row.
  const first = lastJson(
    await capture(() =>
      commandPair(['--data-dir', dataDir, '--vault', 'Family', '--json'], fail, daemon),
    ),
  );
  expect(first.trust).toBe('full');

  // Enroll a device so the vault is no longer empty.
  await capture(() =>
    commandDevices(['add', '--data-dir', dataDir, 'ep-first', '--vault', 'Family'], fail),
  );

  // A later pairing also defaults to full.
  const second = lastJson(
    await capture(() =>
      commandPair(['--data-dir', dataDir, '--vault', 'Family', '--json'], fail, daemon),
    ),
  );
  expect(second.trust).toBe('full');

  await expect(
    commandPair(
      ['--data-dir', dataDir, '--vault', 'Family', '--trust', 'owner', '--json'],
      fail,
      daemon,
    ),
  ).rejects.toThrow(/ordinary pairing grants full or readonly/i);
});

test('pair --json failure emits {ok:false,error,message} on stdout, then still fails the process', async () => {
  let captured = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await expect(
      commandPair(['--data-dir', dataDir, '--json'], fail, async () => {
        throw new Error('connection refused');
      }),
    ).rejects.toThrow(CliFailError);
  } finally {
    process.stdout.write = original;
  }
  const parsed = lastJson(captured);
  expect(parsed).toMatchObject({ ok: false, error: 'error' });
  expect(typeof parsed.message).toBe('string');
});

// ── daemon device plane (deviceAccess + ticket redemption) ─────────────

test('device plane: deviceKeyFor trusts only the in-process proof header', async () => {
  const layout = daemonLayoutFor(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail));

  // Enroll a device out of band, then check the deviceAccess resolution.
  const registry = openVaultRegistry({ rootDir: layout.vaultDir, logger: silentLogger });
  const vaultId = registry.defaultVaultId();
  EnrollmentStore.open(layout.devicesFile).enroll({
    endpointId: 'ep-known',
    vaultId,
    label: 'known',
  });
  const plane = makeDaemonDevicePlane({ layout, vaults: () => registry, logger: silentLogger });

  // No headers → not a device transport (shared bearer).
  const bare = { headers: {} } as unknown as http.IncomingMessage;
  expect(plane.deviceAccess.deviceKeyFor(bare)).toBeUndefined();

  // Device header WITHOUT the process proof → refused (a bearer-holder
  // cannot stamp an identity).
  const spoof = {
    headers: { [DEVICE_HEADER]: 'ep-known', [DEVICE_PROOF_HEADER]: 'forged' },
  } as unknown as http.IncomingMessage;
  expect(plane.deviceAccess.deviceKeyFor(spoof)).toBeUndefined();

  // Enrollment lookup works regardless of proof.
  expect(plane.deviceAccess.vaultsFor('ep-known')).toEqual([vaultId]);
  expect(plane.deviceAccess.vaultsFor('ep-nobody')).toEqual([]);
  registry.stop();
});

test('device plane: an unenrolled endpoint derives identity from the custody key', async () => {
  const layout = daemonLayoutFor(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const registry = openVaultRegistry({ rootDir: layout.vaultDir, logger: silentLogger });
  const plane = makeDaemonDevicePlane({
    layout,
    vaults: () => registry,
    logger: silentLogger,
    relays: 'disabled',
  });
  plane.pairing.tickets.mintFounding();
  expect(registry.isFresh()).toBe(true);
  expect(plane.dataPlaneControl.authorize('first-device')).toMatchObject({ allowed: true });
  // Relays disabled keeps the endpoint offline; identity remains derivable
  // from the custody key without a stale address cache.
  const handle = await plane.startEndpoint({ baseUrl: 'http://127.0.0.1:1', token: 't' });
  try {
    expect(handle?.endpointId).toBeTruthy();
    const secret = new KeyStore(layout.keysDir).load('endpoint-key.bin');
    expect(secret).not.toBeNull();
    expect(endpointIdForSecret(secret!)).toBe(handle!.endpointId);
    expect(handle!.ticket()).toBeTruthy();
  } finally {
    await handle?.close();
    registry.stop();
  }
});
