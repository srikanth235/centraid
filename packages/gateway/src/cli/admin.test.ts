/*
 * The admin plane (issue #289): `centraid-gateway vault|devices|pair` +
 * the daemon device plane. These are landlord acts guarded by shell
 * access, so they operate on `--data-dir` files directly and never ride
 * HTTP — the tests call the command functions the CLI dispatches to and
 * assert on their stdout + the files they write.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { commandVault } from './vault-admin.ts';
import { commandDevices, commandPair } from './device-admin.ts';
import { makeDaemonDevicePlane, DEVICE_HEADER, DEVICE_PROOF_HEADER } from './endpoint-host.ts';
import { daemonLayoutFor } from './paths.ts';
import { openVaultRegistry, type VaultRegistry } from '../serve/vault-registry.ts';
import { EnrollmentStore } from '../serve/enrollment-store.ts';
import { DeviceTokenStore } from '../serve/device-token-store.ts';
import { PairingTicketStore } from '../serve/pairing-store.ts';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

// These filesystem-heavy CLI cases create several complete vaults. Installing
// the issue #406 all-entity trigger catalog is real bootstrap work, and the
// package suite runs many other SQLite/WAL fixtures in parallel; retain a
// bounded timeout without making correctness depend on shared-runner load.
vi.setConfig({ testTimeout: 15_000 });

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
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `admin-${crypto.randomUUID()}-`));
  out = [];
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function lastJson(text: string): Record<string, unknown> {
  const lines = text.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

// ── vault admin ───────────────────────────────────────────────────────

test('vault create / list / rename / delete over the admin plane', async () => {
  // The daemon bootstraps a default vault on first mount; the CLI reads
  // the same root.
  const created = lastJson(
    await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail)),
  );
  expect(created).toMatchObject({ name: 'Family' });

  const listed = (await capture(() => commandVault(['list', '--data-dir', dataDir], fail)))
    .trim()
    .split('\n')
    .filter(Boolean);
  // The bootstrapped default vault + the one we created.
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

  // Deleting the sole bootstrapped vault is refused (a gateway always hosts one).
  const only = lastJson(await capture(() => commandVault(['create', '--data-dir', dataDir], fail)));
  // Two vaults now; delete the bootstrapped one, then the last is protected.
  const [first] = (await capture(() => commandVault(['list', '--data-dir', dataDir], fail)))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { vaultId: string });
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
  // The bootstrapped default vault + the one just created.
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

test("devices revoke cascades into that device key's HTTP token (issue #376)", async () => {
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail));
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Other'], fail));
  const layout = daemonLayoutFor(dataDir);
  const deviceTokens = DeviceTokenStore.open(layout.deviceTokensFile);
  const { token } = deviceTokens.mint({ deviceKey: 'http:device-1', label: 'phone' });

  // Two enrollments for the SAME device key, in different vaults.
  await capture(() =>
    commandDevices(
      ['add', '--data-dir', dataDir, 'http:device-1', '--vault', 'Family', '--label', 'phone'],
      fail,
    ),
  );
  await capture(() =>
    commandDevices(
      ['add', '--data-dir', dataDir, 'http:device-1', '--vault', 'Other', '--label', 'phone'],
      fail,
    ),
  );

  const familyRow = JSON.parse(
    (
      await capture(() =>
        commandDevices(['list', '--data-dir', dataDir, '--vault', 'Family'], fail),
      )
    )
      .trim()
      .split('\n')[0]!,
  ) as { enrollmentId: string };

  // Revoking ONE enrollment (by its row id) leaves the other — the token
  // that key holds must survive.
  await capture(() =>
    commandDevices(['revoke', '--data-dir', dataDir, familyRow.enrollmentId], fail),
  );
  expect(DeviceTokenStore.open(layout.deviceTokensFile).authorize(token)).toEqual({
    deviceKey: 'http:device-1',
  });

  // Revoking by KEY removes every remaining enrollment — the token dies too.
  await capture(() => commandDevices(['revoke', '--data-dir', dataDir, 'http:device-1'], fail));
  expect(DeviceTokenStore.open(layout.deviceTokensFile).authorize(token)).toBeUndefined();
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
  // No endpoint.json yet → the CLI tells the operator to start the daemon once.
  await expect(capture(() => commandPair(['--data-dir', dataDir], fail))).rejects.toThrow(
    /start the daemon once/,
  );

  // Simulate a booted daemon having published its identity.
  const layout = daemonLayoutFor(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    layout.endpointStateFile,
    JSON.stringify({ endpointId: 'gw-endpoint', ticket: 'gw-ticket-base32' }),
  );
  // Bootstrap a vault the ticket can name.
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail));

  const text = await capture(() =>
    commandPair(
      ['--data-dir', dataDir, '--vault', 'Family', '--ttl-minutes', '5', '--trust', 'readonly'],
      fail,
    ),
  );
  expect(text).toMatch(/Pairing ticket for vault "Family"/);
  // The pasteable token decodes to a gw-pair payload naming the vault.
  const tokenLines = text.trim().split('\n').filter(Boolean);
  const token = tokenLines[tokenLines.length - 1]!;
  const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
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

test('pair --json emits one JSON line instead of the pasteable text block (issue #382)', async () => {
  const layout = daemonLayoutFor(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    layout.endpointStateFile,
    JSON.stringify({ endpointId: 'gw-endpoint', ticket: 'gw-ticket-base32' }),
  );
  await capture(() => commandVault(['create', '--data-dir', dataDir, '--name', 'Family'], fail));

  const line = await capture(() =>
    commandPair(['--data-dir', dataDir, '--vault', 'Family', '--json'], fail),
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

test('pair --json failure emits {ok:false,error,message} on stdout, then still fails the process', async () => {
  let captured = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await expect(commandPair(['--data-dir', dataDir, '--json'], fail)).rejects.toThrow(
      CliFailError,
    );
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
  let registry: VaultRegistry | undefined;
  const plane = makeDaemonDevicePlane({ layout, vaults: () => registry, logger: silentLogger });

  // Enroll a device out of band, then check the deviceAccess resolution.
  registry = openVaultRegistry({ rootDir: layout.vaultDir, logger: silentLogger });
  const vaultId = registry.defaultVaultId();
  EnrollmentStore.open(layout.devicesFile).enroll({
    endpointId: 'ep-known',
    vaultId,
    label: 'known',
  });

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

test('device plane: an unenrolled endpoint start still writes endpoint identity', async () => {
  const layout = daemonLayoutFor(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const registry = openVaultRegistry({ rootDir: layout.vaultDir, logger: silentLogger });
  const plane = makeDaemonDevicePlane({
    layout,
    vaults: () => registry,
    logger: silentLogger,
    relays: 'disabled',
  });
  // Relays disabled keeps the endpoint offline; it still mints its identity
  // and publishes endpoint.json for the pair CLI.
  const handle = await plane.startEndpoint({ baseUrl: 'http://127.0.0.1:1', token: 't' });
  try {
    expect(handle?.endpointId).toBeTruthy();
    const state = JSON.parse(readFileSync(layout.endpointStateFile, 'utf8')) as {
      endpointId: string;
      ticket: string;
    };
    expect(state.endpointId).toBe(handle!.endpointId);
    expect(state.ticket).toBeTruthy();
  } finally {
    await handle?.close();
    registry.stop();
  }
});
