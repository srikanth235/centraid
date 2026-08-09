/*
 * `centraid-gateway pair` / `centraid-gateway devices` — device enrollment
 * administration (issue #289 phase 2).
 *
 * `pair` reaches the running loopback daemon through the host-custody bearer
 * and receives a one-line ticket (gateway identity pin + relay hint +
 * one-time secret, short TTL). Desktop / PWA paste the token into "Add
 * gateway"; phones can scan `pair --qr` or paste it in Settings. `devices
 * governance: allow-repo-hygiene file-size-limit (#608) cohesive device-admin command family shares parsing, host-custody auth, and output contracts
 * add` remains the stopped-daemon shortcut when the admin already knows a
 * device EndpointId. Offline mutations take gateway.db's exclusive lock and
 * refuse while the daemon is running. Tickets redeem only through the iroh
 * ceremony, where the joining device proves the EndpointId persisted in its
 * enrollment.
 */

import { handshakeGateway } from "@centraid/protocol";
import { endpointIdForSecret } from "@centraid/tunnel";

import { EnrollmentStore, VaultOwnedError } from "../serve/enrollment-store.js";
import { GatewayDatabase, GatewayLockError } from "../serve/gateway-db.js";
import {
  openVaultRegistry,
  VaultRegistryError,
} from "../serve/vault-registry.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { jsonFail, runJson } from "./json-cli.js";
import type { Fail } from "./json-cli.js";
import { daemonKeyStore } from "./key-store.js";
import { landlordBearerForEndpointSecret } from "./landlord-auth.js";
import { renderTerminalQr } from "./pair-qr.js";
import { daemonLayoutFor } from "./paths.js";
import { resolveDaemonConfig } from "./resolve-config.js";

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
  /** Existing owner (id or exact label) this invitation is minted for. */
  owner?: string;
  /** New person for the stopped-daemon `devices add` lane only. */
  newOwner?: string;
  /** Exact vault name required when the revoke removes the owner's last device. */
  confirmLastDevice?: string;
  /** Emit machine-readable JSON instead of human text (issue #382, `pair` only). */
  json?: boolean;
  /**
   * Human mode: also print a terminal QR of the one-line ticket so a phone
   * can scan it from another screen. Ignored with
   * `--json` (JSON consumers already get `ticket`).
   */
  qr?: boolean;
  positional: string[];
}

function parseDeviceArgs(
  args: string[],
  fail: (msg: string, code?: number) => never
): DeviceArgs {
  const out: DeviceArgs = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const readValue = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`flag "${flag}" requires a value`, 2);
      return v;
    };
    switch (flag) {
      case "--data-dir":
        out.dataDir = readValue();
        break;
      case "--config":
        out.configPath = readValue();
        break;
      case "--port": {
        const n = Number(readValue());
        if (!Number.isInteger(n) || n < 1 || n > 65_535) {
          fail("--port must be an integer in [1, 65535]", 2);
        }
        out.port = n;
        break;
      }
      case "--vault":
        out.vault = readValue();
        break;
      case "--label":
        out.label = readValue();
        break;
      case "--ttl-minutes": {
        const n = Number(readValue());
        if (!Number.isFinite(n) || n <= 0)
          fail("--ttl-minutes must be a positive number", 2);
        out.ttlMinutes = n;
        break;
      }
      case "--owner":
        out.owner = readValue();
        break;
      case "--new-owner":
        out.newOwner = readValue();
        break;
      case "--confirm-last-device":
        out.confirmLastDevice = readValue();
        break;
      case "--json":
        out.json = true;
        break;
      case "--qr":
        out.qr = true;
        break;
      default:
        if (flag.startsWith("--")) fail(`unknown flag "${flag}"`, 2);
        out.positional.push(flag);
    }
  }
  return out;
}

/**
 * Resolve `--vault` (name or id) against the mounted registry. With no
 * selector the default is the owner's PERSONAL vault (the registry's durable
 * `personal` marker), never the shared household vault — a bare
 * `centraid-gateway pair` invites a device into the owner's own space.
 */
function resolveVault(
  registry: VaultRegistry,
  selector: string | undefined,
  fail: (msg: string, code?: number) => never
): { vaultId: string; name: string } {
  const vaults = registry.list();
  if (selector === undefined) {
    const preferred = vaults.find((v) => v.personal) ?? vaults[0];
    if (!preferred) fail("no vault exists yet — run `vault create` first", 1);
    return { vaultId: preferred.vaultId, name: preferred.name };
  }
  const match =
    vaults.find((v) => v.vaultId === selector) ??
    vaults.find((v) => v.name === selector);
  if (!match) fail(`no vault named "${selector}" — try \`vault list\``, 1);
  return { vaultId: match.vaultId, name: match.name };
}

export async function commandPair(
  args: string[],
  fail: (msg: string, code?: number) => never,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  // Pre-scan for `--json` so it governs the whole run — including a `fail()`
  // triggered by argument parsing itself — regardless of flag order.
  const json = args.includes("--json");
  // Explicit annotation: TS's never-return control-flow narrowing (used
  // below on `parsed.dataDir`) only kicks in when the call-derived const is
  // annotated — inferred-from-call-expression alone doesn't carry it.
  const localFail: Fail = jsonFail(json, fail);
  await runJson(json, fail, async () => {
    const parsed = parseDeviceArgs(args, localFail);
    const config = await resolveDaemonConfig(
      { dataDir: parsed.dataDir, configPath: parsed.configPath },
      localFail
    );
    const port = parsed.port ?? config.port;
    if (port === undefined || port === 0) {
      localFail(
        "daemon port is not addressable — configure a fixed loopback port",
        1
      );
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    // `endpointTicket` is auth-gated on `/_gateway/info` (#568 item C). Load the
    // host-custody key first so the readiness handshake can present the landlord
    // bearer; an anonymous GET would look like "iroh not ready" forever.
    const endpointSecret = daemonKeyStore(
      daemonLayoutFor(config.dataDir).keysDir
    ).load("endpoint-key.bin");
    if (!endpointSecret) {
      localFail(
        "daemon has no gateway endpoint identity — restart it with the iroh endpoint enabled",
        1
      );
    }
    const endpointId = endpointIdForSecret(endpointSecret);
    const landlordBearer = landlordBearerForEndpointSecret(endpointSecret);
    const handshake = await handshakeGateway(
      baseUrl,
      landlordBearer,
      fetchImpl
    );
    if (!handshake.ok) {
      localFail(
        `daemon not running at ${baseUrl} — start \`centraid-gateway serve\` (${handshake.detail})`,
        1
      );
    }
    if (handshake.info.endpointId && handshake.info.endpointId !== endpointId) {
      localFail(`daemon at ${baseUrl} owns a different data directory`, 1);
    }
    // `endpointTicket` is auth-gated, so an unauthenticated handshake drops it
    // silently. Reporting that as "the endpoint is not ready" was a lie the
    // owner could not act on (issue #603 C2): the real cause is that the
    // daemon was started with a pinned bearer this CLI cannot derive.
    if (handshake.info.authenticated === false) {
      localFail(
        `daemon at ${baseUrl} rejected this CLI's credential. It was started with a pinned ` +
          "CENTRAID_GATEWAY_TOKEN (or another bearer), and the bearer derived from " +
          "keys/endpoint-key.bin does not match. Restart the daemon without the pin, or run " +
          "this command with CENTRAID_GATEWAY_TOKEN set to the same value.",
        1
      );
    }
    if (typeof handshake.info.endpointTicket !== "string") {
      localFail("daemon is running but its iroh endpoint is not ready", 1);
    }
    let response: Response;
    try {
      response = await fetchImpl(
        `${baseUrl}/centraid/_gateway/devices/ticket`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${landlordBearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...(parsed.vault === undefined ? {} : { vaultId: parsed.vault }),
            ...(parsed.ttlMinutes === undefined
              ? {}
              : { ttlMinutes: parsed.ttlMinutes }),
            ...(parsed.owner === undefined ? {} : { ownerId: parsed.owner }),
          }),
        }
      );
    } catch (error) {
      localFail(
        `daemon stopped before it could mint the ticket: ${error instanceof Error ? error.message : String(error)}`,
        1
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
      ownerId?: string;
      ownerLabel?: string;
      vaults?: Array<{ vaultId: string; vaultName?: string }>;
    };
    if (
      !response.ok ||
      result.ok !== true ||
      typeof result.ticket !== "string" ||
      typeof result.vaultId !== "string" ||
      typeof result.vaultName !== "string" ||
      typeof result.expiresAt !== "string"
    ) {
      localFail(
        result.message ??
          `daemon refused pairing ticket (${result.error ?? response.status})`,
        1
      );
    }
    const token = result.ticket;
    const vault = { vaultId: result.vaultId, name: result.vaultName };
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          ticket: token,
          ownerId: result.ownerId,
          ownerLabel: result.ownerLabel,
          vaults: result.vaults,
          vaultId: vault.vaultId,
          vaultName: vault.name,
          expiresAt: result.expiresAt,
        })}\n`
      );
      return;
    }
    const lines = [
      `Pairing ticket for ${result.ownerLabel ?? "the owner"} (${result.ownerId ?? "unknown"})`,
      ...(
        result.vaults ?? [{ vaultId: vault.vaultId, vaultName: vault.name }]
      ).map(
        (entry) => `  ${entry.vaultName ?? entry.vaultId} (${entry.vaultId})`
      ),
      `Expires: ${result.expiresAt}`,
      "",
      'Desktop / PWA: paste this one-line ticket into "Add gateway":',
      "",
      token,
      "",
    ];
    if (parsed.qr) {
      try {
        const qr = await renderTerminalQr(token);
        lines.push(
          "Phone: scan this QR in Centraid Mobile (Settings → Gateway link), or paste",
          "the same one-line ticket if the camera is unavailable:",
          "",
          qr.trimEnd(),
          ""
        );
      } catch (error) {
        lines.push(
          "Phone: ticket is too long for a terminal QR (relay-heavy EndpointTicket).",
          "Paste the one-line ticket under Settings → Gateway link on the phone instead.",
          `QR encode error: ${error instanceof Error ? error.message : String(error)}`,
          ""
        );
      }
    } else {
      lines.push(
        "Phone on a headless box: re-run with --qr for a terminal QR, or paste",
        "the ticket under Settings → Gateway link on the phone.",
        ""
      );
    }
    process.stdout.write(lines.join("\n"));
  });
}

export async function commandDevices(
  args: string[],
  fail: (msg: string, code?: number) => never
): Promise<void> {
  const [action, ...rest] = args;
  if (!action || !["list", "add", "revoke"].includes(action)) {
    fail("devices subcommand must be one of: list, add, revoke", 2);
  }
  const parsed = parseDeviceArgs(rest, fail);
  if (!parsed.dataDir) fail("--data-dir is required", 2);
  const layout = daemonLayoutFor(parsed.dataDir);
  let database: GatewayDatabase;
  try {
    database = GatewayDatabase.open(parsed.dataDir, {
      lock: action === "list" ? "read-only" : "exclusive",
    });
  } catch (error) {
    if (error instanceof GatewayLockError) {
      fail(
        action === "list"
          ? "the running daemon owns the device registry — query its devices route instead"
          : error.message,
        1
      );
    }
    throw error;
  }
  const devices = EnrollmentStore.open(database);

  try {
    if (action === "list") {
      let rows = devices.list();
      if (parsed.vault !== undefined) {
        const registry = openVaultRegistry({
          rootDir: layout.vaultDir,
          keyStore: daemonKeyStore(layout.keysDir),
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

    if (action === "add") {
      const [endpointId] = parsed.positional;
      if (!endpointId) {
        fail(
          "usage: devices add --data-dir <path> <endpoint-id> --vault <name-or-id>",
          2
        );
      }
      const registry = openVaultRegistry({
        rootDir: layout.vaultDir,
        keyStore: daemonKeyStore(layout.keysDir),
        logger: quietLogger,
        enableWalShipper: false,
      });
      try {
        const vault = resolveVault(registry, parsed.vault, fail);
        // `--owner` binds to an existing person; `--new-owner` creates one.
        // With neither, default to the VAULT's owner — a device added from
        // the host lands with whoever the vault already belongs to; an
        // unowned vault falls back to the device becoming its own owner,
        // the honest reading of a communal box (#599 Decision 4, #726).
        const owner =
          parsed.owner === undefined
            ? undefined
            : devices.owners.find(parsed.owner);
        if (parsed.owner !== undefined && !owner) {
          fail(`no owner matches "${parsed.owner}" — try \`owners list\``, 1);
        }
        const defaultOwnerId =
          owner === undefined && parsed.newOwner === undefined
            ? devices.owners.ownerOf(vault.vaultId)
            : undefined;
        const row = devices.enroll({
          endpointId,
          vaultIds: [vault.vaultId],
          label: parsed.label ?? `device ${endpointId.slice(0, 10)}…`,
          ...(owner
            ? { ownerId: owner.ownerId }
            : defaultOwnerId === undefined
              ? {}
              : { ownerId: defaultOwnerId }),
          ...(parsed.newOwner === undefined
            ? {}
            : { ownerLabel: parsed.newOwner }),
        });
        process.stdout.write(`${JSON.stringify(row)}\n`);
      } catch (error) {
        if (error instanceof VaultRegistryError) fail(error.message, 1);
        if (error instanceof VaultOwnedError) {
          fail(
            `${error.message} — a vault has exactly one owner; pass --owner with that person`,
            1
          );
        }
        throw error;
      } finally {
        registry.stop();
      }
      return;
    }

    // revoke
    const [target] = parsed.positional;
    if (!target)
      fail(
        "usage: devices revoke --data-dir <path> <enrollment-or-endpoint-id>",
        2
      );
    const candidates = devices
      .list()
      .filter(
        (row) => row.enrollmentId === target || row.endpointId === target
      );
    if (candidates.length === 0) fail(`no enrollment matches "${target}"`, 1);
    // Enrollment revocation is also a vault-local data erasure boundary: an
    // offline intent outcome is device-scoped and must not survive unpairing.
    const cleanupRegistry = openVaultRegistry({
      rootDir: layout.vaultDir,
      // Without the daemon's protector every `keys/<id>.sealkey` fails to
      // unwrap, the registry swallows the mount into `failedMountsByDir`, and
      // this loop would silently skip the vault-local data erasure that
      // revocation exists to perform (issue #568 item D).
      keyStore: daemonKeyStore(layout.keysDir),
      logger: quietLogger,
      enableWalShipper: false,
    });
    try {
      // Revoking the owner's last live device strands their vaults behind
      // filesystem-only recovery, so it demands a typed confirmation.
      const liveEndpointsOf = (ownerId: string): Set<string> =>
        new Set(
          devices
            .list()
            .filter((row) => row.ownerId === ownerId && !row.revoked)
            .map((row) => row.endpointId)
        );
      const lastDevices = candidates.filter((row) => {
        if (devices.owners.ownerOf(row.vaultId) !== row.ownerId) return false;
        const live = liveEndpointsOf(row.ownerId);
        return live.size === 1 && live.has(row.endpointId);
      });
      if (new Set(lastDevices.map((row) => row.vaultId)).size > 1) {
        fail(
          "this endpoint is the owner's last device for multiple vaults; revoke each enrollment id separately",
          1
        );
      }
      const lastDevice = lastDevices[0];
      if (lastDevice) {
        const vaultName =
          cleanupRegistry.get(lastDevice.vaultId)?.name ??
          cleanupRegistry
            .list()
            .find((vault) => vault.vaultId === lastDevice.vaultId)?.name ??
          lastDevice.vaultId;
        if (parsed.confirmLastDevice !== vaultName) {
          fail(
            `this is the owner's last device; pass --confirm-last-device ${JSON.stringify(vaultName)}. ` +
              "Losing it requires filesystem access and `centraid-gateway devices add` to recover.",
            1
          );
        }
      }
      const removed = devices.revoke(target);
      for (const row of removed) {
        cleanupRegistry.get(row.vaultId)?.forgetReplicaDevice(row.endpointId);
      }
      for (const row of removed)
        process.stdout.write(`${JSON.stringify({ revoked: row })}\n`);
    } finally {
      cleanupRegistry.stop();
    }
  } finally {
    database.close();
  }
}
