/*
 * `centraid-gateway pair` / `centraid-gateway devices` — stopped-daemon
 * filesystem maintenance for device enrollment (issue #289 phase 2).
 *
 * SSH is the bootstrap channel for headless gateways: the landlord runs
 * `pair --vault <name>` on the box, gets a one-line ticket (gateway
 * identity pin + relay hint + one-time secret, short TTL), and hands it to
 * the device being enrolled. Desktop / PWA paste the token into "Add
 * gateway"; phones scan `pair --qr` (terminal block QR of the same token)
 * or paste it in Settings. `devices add` is the direct shortcut when the
 * admin already knows a device's EndpointId (the desktop shows its own in
 * Settings). Mutations take gateway.db's exclusive lock and refuse while the
 * daemon is running. Tickets redeem only through the iroh ceremony, where the
 * joining device proves the EndpointId persisted in its enrollment.
 */

import { handshakeGateway } from '@centraid/protocol';
import { endpointIdForSecret } from '@centraid/tunnel';
import {
  openVaultRegistry,
  VaultRegistryError,
  type VaultRegistry,
} from '../serve/vault-registry.js';
import { EnrollmentStore, type GrantableTrust } from '../serve/enrollment-store.js';
import { GatewayDatabase, GatewayLockError } from '../serve/gateway-db.js';
import { daemonLayoutFor } from './paths.js';
import { daemonKeyStore } from './key-store.js';
import { landlordBearerForEndpointSecret } from './landlord-auth.js';
import { jsonFail, runJson, type Fail } from './json-cli.js';
import { renderTerminalQr } from './pair-qr.js';
import { resolveDaemonConfig } from './resolve-config.js';

const quietLogger = {
  info: () => undefined,
  warn: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
  error: (msg: string) => process.stderr.write(`centraid-gateway: ${msg}\n`),
};

interface DeviceArgs {
  dataDir?: string;
  configPath?: string;
  port?: number;
  vault?: string;
  label?: string;
  ttlMinutes?: number;
  trust?: GrantableTrust;
  /** Exact vault name required when the requested revoke removes its last owner. */
  confirmLastOwner?: string;
  /** Emit machine-readable JSON instead of human text (issue #382, `pair` only). */
  json?: boolean;
  /**
   * Human mode: also print a terminal QR of the one-line ticket so a phone
   * can scan it from an SSH session (VPS headless bootstrap). Ignored with
   * `--json` (JSON consumers already get `ticket`).
   */
  qr?: boolean;
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
      case '--config':
        out.configPath = next();
        break;
      case '--port': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1 || n > 65_535) {
          fail('--port must be an integer in [1, 65535]', 2);
        }
        out.port = n;
        break;
      }
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
      case '--trust': {
        const trust = next();
        if (trust !== 'owner' && trust !== 'full' && trust !== 'readonly') {
          fail('--trust must be "owner", "full", or "readonly"', 2);
        }
        out.trust = trust;
        break;
      }
      case '--confirm-last-owner':
        out.confirmLastOwner = next();
        break;
      case '--json':
        out.json = true;
        break;
      case '--qr':
        out.qr = true;
        break;
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

export async function commandPair(
  args: string[],
  fail: (msg: string, code?: number) => never,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // Pre-scan for `--json` so it governs the whole run — including a `fail()`
  // triggered by argument parsing itself — regardless of flag order.
  const json = args.includes('--json');
  // Explicit annotation: TS's never-return control-flow narrowing (used
  // below on `parsed.dataDir`) only kicks in when the call-derived const is
  // annotated — inferred-from-call-expression alone doesn't carry it.
  const localFail: Fail = jsonFail(json, fail);
  await runJson(json, fail, async () => {
    const parsed = parseDeviceArgs(args, localFail);
    const config = await resolveDaemonConfig(
      { dataDir: parsed.dataDir, configPath: parsed.configPath },
      localFail,
    );
    const port = parsed.port ?? config.port;
    if (port === undefined || port === 0) {
      localFail('daemon port is not addressable — configure a fixed loopback port', 1);
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    const handshake = await handshakeGateway(baseUrl, undefined, fetchImpl);
    if (!handshake.ok) {
      localFail(
        `daemon not running at ${baseUrl} — start \`centraid-gateway serve\` (${handshake.detail})`,
        1,
      );
    }
    const endpointSecret = daemonKeyStore(daemonLayoutFor(config.dataDir).keysDir).load(
      'endpoint-key.bin',
    );
    if (!endpointSecret) {
      localFail(
        'daemon has no gateway endpoint identity — restart it with the iroh endpoint enabled',
        1,
      );
    }
    const endpointId = endpointIdForSecret(endpointSecret);
    const landlordBearer = landlordBearerForEndpointSecret(endpointSecret);
    if (
      handshake.info.endpointId !== endpointId ||
      typeof handshake.info.endpointTicket !== 'string'
    ) {
      localFail(
        handshake.info.endpointId && handshake.info.endpointId !== endpointId
          ? `daemon at ${baseUrl} owns a different data directory`
          : 'daemon is running but its iroh endpoint is not ready',
        1,
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/centraid/_gateway/devices/ticket`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${landlordBearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...(parsed.vault !== undefined ? { vaultId: parsed.vault } : {}),
          ...(parsed.ttlMinutes !== undefined ? { ttlMinutes: parsed.ttlMinutes } : {}),
          ...(parsed.trust !== undefined ? { trust: parsed.trust } : {}),
        }),
      });
    } catch (error) {
      localFail(
        `daemon stopped before it could mint the ticket: ${error instanceof Error ? error.message : String(error)}`,
        1,
      );
    }
    const result = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
      ticket?: string;
      vaultId?: string;
      vaultName?: string;
      expiresAt?: string;
      trust?: GrantableTrust;
    };
    if (
      !response.ok ||
      result.ok !== true ||
      typeof result.ticket !== 'string' ||
      typeof result.vaultId !== 'string' ||
      typeof result.vaultName !== 'string' ||
      typeof result.expiresAt !== 'string' ||
      (result.trust !== 'owner' && result.trust !== 'full' && result.trust !== 'readonly')
    ) {
      localFail(
        result.message ?? `daemon refused pairing ticket (${result.error ?? response.status})`,
        1,
      );
    }
    const token = result.ticket;
    const vault = { vaultId: result.vaultId, name: result.vaultName };
    const trust = result.trust;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          ticket: token,
          vaultId: vault.vaultId,
          vaultName: vault.name,
          expiresAt: result.expiresAt,
          trust,
        })}\n`,
      );
      return;
    }
    const lines = [
      `Pairing ticket for vault "${vault.name}" (${vault.vaultId})`,
      `Trust: ${trust}`,
      `Expires: ${result.expiresAt}`,
      '',
      'Desktop / PWA: paste this one-line ticket into "Add gateway":',
      '',
      token,
      '',
    ];
    if (parsed.qr) {
      try {
        const qr = await renderTerminalQr(token);
        lines.push(
          'Phone: scan this QR in Centraid Mobile (Settings → Gateway link), or paste',
          'the same one-line ticket if the camera is unavailable:',
          '',
          qr.trimEnd(),
          '',
        );
      } catch (err) {
        lines.push(
          'Phone: ticket is too long for a terminal QR (relay-heavy EndpointTicket).',
          'Paste the one-line ticket under Settings → Gateway link on the phone instead.',
          `QR encode error: ${err instanceof Error ? err.message : String(err)}`,
          '',
        );
      }
    } else {
      lines.push(
        'Phone on a headless box: re-run with --qr for a terminal QR, or paste',
        'the ticket under Settings → Gateway link on the phone.',
        '',
      );
    }
    process.stdout.write(lines.join('\n'));
  });
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
  let database: GatewayDatabase;
  try {
    database = GatewayDatabase.open(parsed.dataDir, {
      lock: action === 'list' ? 'read-only' : 'exclusive',
    });
  } catch (error) {
    if (error instanceof GatewayLockError) {
      fail(
        action === 'list'
          ? 'the running daemon owns the device registry — query its devices route instead'
          : error.message,
        1,
      );
    }
    throw error;
  }
  const devices = EnrollmentStore.open(database);

  try {
    if (action === 'list') {
      let rows = devices.list();
      if (parsed.vault !== undefined) {
        const registry = openVaultRegistry({
          rootDir: layout.vaultDir,
          logger: quietLogger,
          enableWalShipper: false,
        });
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
      const registry = openVaultRegistry({
        rootDir: layout.vaultDir,
        logger: quietLogger,
        enableWalShipper: false,
      });
      try {
        const vault = resolveVault(registry, parsed.vault, fail);
        const row = devices.enroll({
          endpointId,
          vaultId: vault.vaultId,
          label: parsed.label ?? `device ${endpointId.slice(0, 10)}…`,
          ...(parsed.trust ? { trust: parsed.trust } : {}),
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
    const candidates = devices
      .list()
      .filter((row) => row.enrollmentId === target || row.endpointId === target);
    if (candidates.length === 0) fail(`no enrollment matches "${target}"`, 1);
    // Enrollment revocation is also a vault-local data erasure boundary: an
    // offline intent outcome is device-scoped and must not survive unpairing.
    const cleanupRegistry = openVaultRegistry({
      rootDir: layout.vaultDir,
      logger: quietLogger,
      enableWalShipper: false,
    });
    try {
      const lastOwners = candidates.filter(
        (row) =>
          row.trust === 'owner' &&
          devices.listByVault(row.vaultId).filter((candidate) => candidate.trust === 'owner')
            .length === 1,
      );
      if (lastOwners.length > 1) {
        fail(
          'this endpoint is the last owner of multiple vaults; revoke each enrollment id separately',
          1,
        );
      }
      const lastOwner = lastOwners[0];
      if (lastOwner) {
        const vaultName =
          cleanupRegistry.get(lastOwner.vaultId)?.name ??
          cleanupRegistry.list().find((vault) => vault.vaultId === lastOwner.vaultId)?.name ??
          lastOwner.vaultId;
        if (parsed.confirmLastOwner !== vaultName) {
          fail(
            `this is the last owner enrollment; pass --confirm-last-owner ${JSON.stringify(vaultName)}. ` +
              'Losing it requires filesystem access and `centraid-gateway devices add --trust owner` to recover.',
            1,
          );
        }
      }
      const removed = devices.revoke(target);
      for (const row of removed) {
        cleanupRegistry.get(row.vaultId)?.forgetReplicaDevice(row.endpointId);
      }
      for (const row of removed) process.stdout.write(`${JSON.stringify({ revoked: row })}\n`);
    } finally {
      cleanupRegistry.stop();
    }
  } finally {
    database.close();
  }
}
