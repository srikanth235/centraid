/*
 * `centraid-gateway pair` / `centraid-gateway devices` — the ADMIN plane
 * for device enrollment (issue #289 phase 2).
 *
 * SSH is the bootstrap channel for headless gateways: the landlord runs
 * `pair --vault <name>` on the box, gets a one-line ticket (gateway
 * identity pin + relay hint + one-time secret, short TTL), and hands it to
 * the device being enrolled. `devices add` is the direct shortcut when the
 * admin already knows a device's EndpointId (the desktop shows its own in
 * Settings). Both write files the daemon re-reads live — no restart.
 *
 * The SAME ticket also redeems over plain HTTP (`POST
 * /centraid/_gateway/pair`, `routes/pair-routes.ts`, issue #376) for a
 * device that cannot dial iroh — that path mints an `EnrollmentStore` row
 * exactly like `devices add` (its `endpointId` is a synthetic
 * `http:<uuid>`), plus a per-device HTTP token. `devices list` therefore
 * already shows HTTP-redeemed devices; `devices revoke` cascades into
 * their token too (a device key with no enrollments left anywhere loses
 * the token that rode it).
 */

import fs from 'node:fs';
import {
  openVaultRegistry,
  VaultRegistryError,
  type VaultRegistry,
} from '../serve/vault-registry.js';
import { EnrollmentStore } from '../serve/enrollment-store.js';
import {
  PairingTicketStore,
  encodePairingTicket,
  DEFAULT_TICKET_TTL_MS,
} from '../serve/pairing-store.js';
import { DeviceTokenStore } from '../serve/device-token-store.js';
import { daemonLayoutFor, type DaemonLayout } from './paths.js';

const quietLogger = {
  info: () => undefined,
  warn: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
  error: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
};

interface DeviceArgs {
  dataDir?: string;
  vault?: string;
  label?: string;
  ttlMinutes?: number;
  positional: string[];
}

function parseDeviceArgs(args: string[], fail: (msg: string, code?: number) => never): DeviceArgs {
  const out: DeviceArgs = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`flag "${flag}" requires a value`, 2);
      return v;
    };
    switch (flag) {
      case '--data-dir':
        out.dataDir = next();
        break;
      case '--vault':
        out.vault = next();
        break;
      case '--label':
        out.label = next();
        break;
      case '--ttl-minutes': {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) fail('--ttl-minutes must be a positive number', 2);
        out.ttlMinutes = n;
        break;
      }
      default:
        if (flag.startsWith('--')) fail(`unknown flag "${flag}"`, 2);
        out.positional.push(flag);
    }
  }
  return out;
}

/** Resolve `--vault` (name or id) against the mounted registry; default = oldest. */
function resolveVault(
  registry: VaultRegistry,
  selector: string | undefined,
  fail: (msg: string, code?: number) => never,
): { vaultId: string; name: string } {
  const vaults = registry.list();
  if (selector === undefined) {
    const oldest = vaults[0];
    if (!oldest) fail('no vault exists yet — run `vault create` first', 1);
    return { vaultId: oldest.vaultId, name: oldest.name };
  }
  const match =
    vaults.find((v) => v.vaultId === selector) ?? vaults.find((v) => v.name === selector);
  if (!match) fail(`no vault named "${selector}" — try \`vault list\``, 1);
  return { vaultId: match.vaultId, name: match.name };
}

function readEndpointState(
  layout: DaemonLayout,
  fail: (msg: string, code?: number) => never,
): { endpointId: string; ticket: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(layout.endpointStateFile, 'utf8');
  } catch {
    fail(
      `no gateway endpoint identity at ${layout.endpointStateFile} — ` +
        'start the daemon once (`centraid-gateway serve`) so it mints its iroh endpoint',
      1,
    );
  }
  const parsed = JSON.parse(raw) as { endpointId?: unknown; ticket?: unknown };
  if (typeof parsed.endpointId !== 'string' || typeof parsed.ticket !== 'string') {
    fail(`unreadable endpoint state at ${layout.endpointStateFile}`, 1);
  }
  return { endpointId: parsed.endpointId, ticket: parsed.ticket };
}

export async function commandPair(
  args: string[],
  fail: (msg: string, code?: number) => never,
): Promise<void> {
  const parsed = parseDeviceArgs(args, fail);
  if (!parsed.dataDir) fail('--data-dir is required', 2);
  const layout = daemonLayoutFor(parsed.dataDir);
  const endpoint = readEndpointState(layout, fail);
  const registry = openVaultRegistry({ rootDir: layout.vaultDir, logger: quietLogger });
  try {
    const vault = resolveVault(registry, parsed.vault, fail);
    const tickets = PairingTicketStore.open(layout.pairingTicketsFile);
    const ttlMs =
      parsed.ttlMinutes !== undefined ? parsed.ttlMinutes * 60 * 1000 : DEFAULT_TICKET_TTL_MS;
    const minted = tickets.mint(vault.vaultId, ttlMs);
    const token = encodePairingTicket({
      v: 1,
      kind: 'centraid-gw-pair',
      gw: endpoint.ticket,
      t: minted.ticketId,
      s: minted.secret,
      vaultName: vault.name,
      exp: minted.expiresAt,
    });
    process.stdout.write(
      [
        `Pairing ticket for vault "${vault.name}" (${vault.vaultId})`,
        `Expires: ${new Date(minted.expiresAt).toISOString()}`,
        '',
        'Paste this one-line ticket into the client\'s "Add gateway" dialog:',
        '',
        token,
        '',
      ].join('\n'),
    );
  } finally {
    registry.stop();
  }
}

export async function commandDevices(
  args: string[],
  fail: (msg: string, code?: number) => never,
): Promise<void> {
  const [action, ...rest] = args;
  if (!action || !['list', 'add', 'revoke'].includes(action)) {
    fail('devices subcommand must be one of: list, add, revoke', 2);
  }
  const parsed = parseDeviceArgs(rest, fail);
  if (!parsed.dataDir) fail('--data-dir is required', 2);
  const layout = daemonLayoutFor(parsed.dataDir);
  const devices = EnrollmentStore.open(layout.devicesFile);

  if (action === 'list') {
    let rows = devices.list();
    if (parsed.vault !== undefined) {
      const registry = openVaultRegistry({ rootDir: layout.vaultDir, logger: quietLogger });
      try {
        const vault = resolveVault(registry, parsed.vault, fail);
        rows = devices.listByVault(vault.vaultId);
      } finally {
        registry.stop();
      }
    }
    for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }

  if (action === 'add') {
    const [endpointId] = parsed.positional;
    if (!endpointId) {
      fail('usage: devices add --data-dir <path> <endpoint-id> --vault <name-or-id>', 2);
    }
    const registry = openVaultRegistry({ rootDir: layout.vaultDir, logger: quietLogger });
    try {
      const vault = resolveVault(registry, parsed.vault, fail);
      const row = devices.enroll({
        endpointId,
        vaultId: vault.vaultId,
        label: parsed.label ?? `device ${endpointId.slice(0, 10)}…`,
      });
      process.stdout.write(`${JSON.stringify(row)}\n`);
    } catch (err) {
      if (err instanceof VaultRegistryError) fail(err.message, 1);
      throw err;
    } finally {
      registry.stop();
    }
    return;
  }

  // revoke
  const [target] = parsed.positional;
  if (!target) fail('usage: devices revoke --data-dir <path> <enrollment-or-endpoint-id>', 2);
  const removed = devices.revoke(target);
  if (removed.length === 0) fail(`no enrollment matches "${target}"`, 1);
  // A device key that no longer holds ANY enrollment loses its HTTP token
  // too (issue #376) — the ACL bit is gone; the token that rode it dies
  // with it. A key that still holds another vault's row keeps its token
  // (revoking one row is "leave this vault", not "kill the device").
  const deviceTokens = DeviceTokenStore.open(layout.deviceTokensFile);
  const deadKeys = new Set(removed.map((r) => r.endpointId).filter((key) => !devices.isEnrolled(key)));
  for (const key of deadKeys) deviceTokens.revokeForDeviceKey(key);
  for (const row of removed) process.stdout.write(`${JSON.stringify({ revoked: row })}\n`);
}
