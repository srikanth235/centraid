#!/usr/bin/env node
/*
 * `centraid-gateway` — the standalone daemon around the same `serve()` the
 * desktop embeds. `usage()` below is the authority on subcommands and flags.
 *
 * The loopback bearer is DERIVED FROM CUSTODY (#505, #568):
 * `HMAC(endpoint-key.bin, "centraid/landlord-http/v1")` — never written to
 * disk, never printed, never rotated. Any local process that can open the
 * KeyStore reproduces it, which is how the CLI and the desktop reach a daemon
 * they did not spawn; a spawning parent may pin `CENTRAID_GATEWAY_TOKEN`.
 *
 * No TLS in v0 (#131): loopback or LAN bind only, remote access iroh-only with
 * a proved EndpointId per request. Maintenance commands take gateway.db's
 * exclusive lock and refuse while the daemon runs.
 */

import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assistOAuthFromEnvironment } from "../serve/assist-oauth.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { kitlessHostIdentity } from "../serve/host-identity.js";
import { findSequentially } from "../serve/sequential.js";
import { serve } from "../serve/serve.js";
import type * as TypeImport_lkogjn from "../serve/vault-registry.js";
import { WebControlSessionStore } from "../serve/web-session-store.js";
import { mergeAllowedHosts } from "./allowed-hosts.js";
import { commandBackup } from "./backup-admin.js";
import { parseServeArgsPure } from "./cli-serve-args.js";
import type { ParsedServe } from "./cli-serve-args.js";
import type { DaemonConfig } from "./config.js";
import { commandDevices, commandPair } from "./device-admin.js";
import { commandDoctor } from "./doctor.js";
import { makeDaemonDevicePlane } from "./endpoint-host.js";
import { seedHarnessPrefs } from "./harness-prefs.js";
import { commandKey } from "./key-admin.js";
import { daemonKeyStore } from "./key-store.js";
import { landlordBearerForEndpointSecret } from "./landlord-auth.js";
import { commandLockStatus } from "./lock-admin.js";
import { commandOwners } from "./owner-admin.js";
import { daemonLayoutFor } from "./paths.js";
import { commandRecover } from "./recover-admin.js";
import { resolveDaemonConfig } from "./resolve-config.js";
import { commandService } from "./service-admin.js";
import { commandStatus } from "./status-admin.js";
import { commandVault } from "./vault-admin.js";

const PKG_VERSION = "0.1.0";

async function bundledWebRoot(): Promise<string | undefined> {
  const candidates = [
    fileURLToPath(new URL("../web", import.meta.url)),
    fileURLToPath(new URL("../../dist/web", import.meta.url)),
  ];
  return findSequentially(candidates, async (candidate) => {
    try {
      await fs.access(path.join(candidate, "index.html"));
      return true;
    } catch {
      // Try the built-package alternative.
      return false;
    }
  });
}

function fail(message: string, code = 1): never {
  process.stderr.write(`centraid-gateway: ${message}\n`);
  process.exit(code);
}

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  centraid-gateway serve [--config <path>] [--data-dir <path>] [--host <h>] [--port <p>] [--allowed-host <name>]…",
      "  centraid-gateway vault list --data-dir <path> [--json]",
      "  centraid-gateway vault create --data-dir <path> [--name <name>] [--json]",
      "  centraid-gateway vault rename --data-dir <path> <vaultId> <name>",
      "  centraid-gateway vault delete --data-dir <path> <vaultId>",
      "  centraid-gateway pair [--config <path> | --data-dir <path>] [--port <p>] [--vault <name-or-id>] [--owner <id-or-label>] [--ttl-minutes <n>] [--qr] [--json]",
      "  centraid-gateway owners list --data-dir <path>",
      "  centraid-gateway owners add --data-dir <path> <label>",
      "  centraid-gateway owners rename --data-dir <path> <owner-id-or-label> --label <new-label>",
      "  centraid-gateway owners remove --data-dir <path> <owner-id-or-label>",
      "  centraid-gateway devices list --data-dir <path> [--vault <name-or-id>]",
      "  centraid-gateway devices add --data-dir <path> <endpoint-id> --vault <name-or-id> [--label <l>] [--owner <id-or-label> | --new-owner <label>]",
      "  centraid-gateway devices revoke --data-dir <path> <enrollment-or-endpoint-id>",
      "  centraid-gateway key status  --data-dir <path> --vault <name-or-id>",
      "  centraid-gateway key rotate  --data-dir <path> --vault <name-or-id>",
      "  centraid-gateway backup status  [--config <path> | --data-dir <path>]",
      "  centraid-gateway backup run     [--config <path> | --data-dir <path>] [--vault <id>]",
      "  centraid-gateway backup list    [--config <path> | --data-dir <path>] [--vault <id>]",
      "  centraid-gateway backup verify  [--config <path> | --data-dir <path>] [--vault <id>]",
      "  centraid-gateway backup restore [--config <path> | --data-dir <path>] --vault <id> --dest <dir> [--seq <n>]",
      "  centraid-gateway backup kit     [--config <path> | --data-dir <path>] --out <file>",
      "  centraid-gateway recover --kit <file> --password-file <file> --api-key <key> --data-dir <path> [--at <iso>] [--full] [--vault <id>] [--yes]",
      "  centraid-gateway service install   [--data-dir <path> | --config <path>] [--host <h>] [--port <p>] [--dry-run] [--label <id>]",
      "  centraid-gateway service uninstall [--dry-run] [--label <id>]",
      "  centraid-gateway service status    [--dry-run] [--label <id>]",
      "  centraid-gateway status [--data-dir <path> | --config <path>] [--label <id>] [--json]",
      "  centraid-gateway lock-status [--data-dir <path> | --config <path>] [--json]",
      "  centraid-gateway doctor [--data-dir <path>] [--vault <id>] [--full] [--json]",
      "  centraid-gateway --version",
      "  centraid-gateway --help",
      "",
      "vault/owners/devices/key are stopped-daemon maintenance commands:",
      "mutations take gateway.db's exclusive lock and refuse while the",
      "daemon is running. Recovery uses only a password-wrapped recovery kit;",
      "no command emits a raw vault key.",
      "",
      "pair talks to the live loopback daemon using its host-custody bearer.",
      "It pairs another device to an existing owner (default: the vault's).",
      "Access is ownership: a device reaches the vaults its owner owns.",
      "`pair --qr` prints a UTF-8 block QR of the one-line iroh ticket for",
      "phone cameras; redemption proves the joining device EndpointId.",
      "",
      "backup is the offsite engine (PROTOCOL.md/FORMAT.md), config from the",
      "same --config/--data-dir resolution `serve` uses (its JSON config",
      'file\'s "backup" key). restore materializes into --dest — it never',
      "swaps the live vault; kit emits live key material, store it offline.",
      "",
      "recover (issue #439) is the recovery VERB for a blank machine: with",
      "nothing but the recovery kit (--kit), its password file, and provider api-key",
      "(--api-key), it restores the vault into --data-dir, seeds a fenced",
      "backup state so the old machine is superseded, and adopts the result as",
      "a live vault (its quarantine fires on first mount). Lazy by default;",
      "--full materializes every blob; --at is point-in-time recovery. A",
      "metered-egress home needs --yes.",
      "",
      "serve flags override the config file. --data-dir is required if no",
      "--config is supplied (the config file otherwise carries dataDir).",
      "",
      "service install/uninstall/status generate and manage a real OS service",
      "unit for the headless daemon — a macOS LaunchAgent (launchctl) or a",
      "systemd --user unit — so it survives a reboot and restarts on crash",
      "(issue #351). install writes the unit pointing `serve` at the SAME",
      "--data-dir/--config it was given; --dry-run prints the unit and the",
      "commands without writing or running anything.",
      "",
      "status (issue #382) is a one-shot combined read: the same OS service",
      "probe `service status` runs, plus (when --data-dir/--config is given)",
      "whether the data dir exists, its persisted iroh endpoint id, and its",
      "vault count. No HTTP liveness check — serve() never persists which",
      "host:port it bound to, so there is nothing on disk to dial.",
      "",
      "Bind defaults to 127.0.0.1:0 (loopback, OS-assigned port). Pass",
      "--host 0.0.0.0 to bind LAN-reachable interfaces. Host header allowlist",
      "still accepts only loopback names unless you pass --allowed-host <name>",
      "(repeatable) and/or CENTRAID_ALLOWED_HOSTS=comma,separated. There is no",
      "TLS terminator in v0; front with Caddy / Tailscale Funnel / Cloudflare",
      "Tunnel if exposing beyond a trusted LAN.",
      "",
    ].join("\n")
  );
  process.exit(2);
}

function parseServeArgs(args: string[]): ParsedServe {
  const parsed = parseServeArgsPure(args);
  if (parsed.ok) return parsed.value;
  if ("help" in parsed) usage();
  fail(parsed.message, parsed.code);
}

async function resolveConfig(parsed: ParsedServe): Promise<DaemonConfig> {
  const cfg = await resolveDaemonConfig(parsed, fail);
  if (parsed.host) cfg.host = parsed.host;
  if (parsed.port !== undefined) cfg.port = parsed.port;
  return cfg;
}

async function commandServe(args: string[]): Promise<void> {
  const parsed = parseServeArgs(args);
  const config = await resolveConfig(parsed);
  const layout = daemonLayoutFor(config.dataDir);

  await fs.mkdir(config.dataDir, { recursive: true });
  const gatewayDatabase = GatewayDatabase.open(config.dataDir, {
    lock: "exclusive",
  });

  // The loopback bearer unlocks the loopback door only (#505, #568): a
  // forwarded iroh request also carries the per-boot device proof header, and
  // `composedHandler` scopes on that identity, never on this bearer.
  const dataPlaneSecret = process.env.CENTRAID_DATA_PLANE_SECRET;
  const dataPlaneHttpUrl = process.env.CENTRAID_DATA_PLANE_HTTP_URL;
  const desktopEndpointId =
    process.env.CENTRAID_DESKTOP_ENDPOINT_ID?.trim() || undefined;

  // Device plane (#289). Construct it BEFORE serve() so `deviceAccess`
  // participates in every request; the endpoint binds after the listener.
  const logger = {
    info: (msg: string) => process.stdout.write(`[centraid-gateway] ${msg}\n`),
    warn: (msg: string) => process.stderr.write(`[centraid-gateway] ${msg}\n`),
    error: (msg: string) => process.stderr.write(`[centraid-gateway] ${msg}\n`),
  };
  const keyStore = daemonKeyStore(layout.keysDir, {
    warn: (message) => logger.warn(message),
  });
  const loopbackSecret =
    process.env.CENTRAID_GATEWAY_TOKEN?.trim() ||
    landlordBearerForEndpointSecret(keyStore.loadOrCreate("endpoint-key.bin"));
  // The daemon always has a host identity: auto-founded vaults are owned by it
  // (#603) and `pair` mints against it.
  const hostEndpointId =
    desktopEndpointId ??
    kitlessHostIdentity(keyStore.loadOrCreate("endpoint-key.bin"));
  let vaultsRef: TypeImport_lkogjn.VaultRegistry | undefined = undefined;
  const devicePlane = makeDaemonDevicePlane({
    layout,
    gatewayDatabase,
    vaults: () => vaultsRef,
    logger,
    keyStore,
    ...(dataPlaneSecret ? { controlSecret: dataPlaneSecret } : {}),
    loopbackEndpointId: hostEndpointId,
  });

  // Device authorization still resolves through a real EndpointId enrollment.
  const webRoot = await bundledWebRoot();
  const allowedHosts = mergeAllowedHosts(parsed.allowedHosts);
  const handle = await serve({
    assistOAuth: assistOAuthFromEnvironment(process.env),
    paths: layout,
    gatewayDatabase,
    ...(config.host === undefined ? {} : { host: config.host }),
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(config.backup ? { backup: config.backup } : {}),
    ...(config.resourceMode === undefined
      ? {}
      : { resourceMode: config.resourceMode }),
    ...(config.experimental === undefined
      ? {}
      : { experimental: config.experimental }),
    token: loopbackSecret,
    logTag: "centraid-gateway",
    deviceAccess: devicePlane.deviceAccess,
    isHostCustody: devicePlane.isHostCustody,
    keyStore,
    hostDeviceEndpointId: hostEndpointId,
    dataPlaneControl: devicePlane.dataPlaneControl,
    ...(dataPlaneSecret && dataPlaneHttpUrl
      ? {
          dataPlaneHttp: {
            baseUrl: dataPlaneHttpUrl,
            secret: dataPlaneSecret,
            rootDir: layout.vaultDir,
          },
        }
      : {}),
    peerPlane: devicePlane.peerPlane,
    devicePairing: {
      ...devicePlane.pairing,
      endpointId: () => endpoint?.endpointId,
      endpointTicket: () => endpoint?.ticket(),
      onEndpointRevoked: (endpointId) => endpoint?.revokeEndpoint(endpointId),
    },
    // Durable PWA control sessions (#376). Revocation must read the SAME
    // enrollment store the endpoint admits from.
    webSessions: {
      controlStore: WebControlSessionStore.open(gatewayDatabase),
      isDeviceValid: (key) => devicePlane.pairing.enrollments.isEnrolled(key),
    },
    ...(webRoot
      ? {
          web: {
            rootDir: webRoot,
            ...(config.host ? { host: config.host } : {}),
            // API port + 1; `startWebUiServer` falls back to an ephemeral port
            // so a web-port collision never takes down the API.
            ...(config.port !== undefined && config.port < 65_535
              ? { port: config.port === 0 ? 0 : config.port + 1 }
              : {}),
          },
        }
      : {}),
  });
  vaultsRef = handle.vaults;

  // The gateway's permanent identity and only remote transport (#289).
  // Best-effort: loopback maintenance must start without iroh.
  const endpoint =
    config.endpoint === false
      ? undefined
      : await devicePlane.startEndpoint({
          baseUrl: handle.url,
          token: loopbackSecret,
        });
  if (endpoint) {
    process.stdout.write(
      `[centraid-gateway] endpoint: ${endpoint.endpointId}\n`
    );
  }

  // After serve(); the write is an atomic replace, so re-seeding is safe.
  try {
    seedHarnessPrefs(handle.prefs, config);
  } catch (error) {
    process.stderr.write(
      `[centraid-gateway] warning: failed to seed harness prefs: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }

  // Never print the loopback secret (#505): it is plumbing, not a credential.
  process.stdout.write(
    `[centraid-gateway] listening on ${handle.url}\n${handle.webUrl ? `[centraid-gateway] web app: ${handle.webUrl}\n` : ""}[centraid-gateway] dataDir: ${path.resolve(config.dataDir)}\n`
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    process.stderr.write(
      `[centraid-gateway] ${signal} received — shutting down\n`
    );
    await endpoint?.close().catch(() => undefined);
    await devicePlane.closePeerDial().catch(() => undefined);
    await handle.close().catch((error) => {
      process.stderr.write(
        `[centraid-gateway] close error: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
    process.exit(0);
  };
  process.on("SIGINT", (signal) => void shutdown(signal));
  process.on("SIGTERM", (signal) => void shutdown(signal));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [sub, ...rest] = argv;
  if (sub === "--version" || sub === "-v") {
    process.stdout.write(`${PKG_VERSION}\n`);
    return;
  }
  if (!sub || sub === "--help" || sub === "-h") usage();
  switch (sub) {
    case "serve":
      await commandServe(rest);
      return;
    case "vault":
      await commandVault(rest, fail);
      return;
    case "pair":
      await commandPair(rest, fail);
      return;
    case "owners":
      commandOwners(rest, fail);
      break;
    case "devices":
      await commandDevices(rest, fail);
      return;
    case "key":
      await commandKey(rest, fail);
      return;
    case "backup":
      await commandBackup(rest, fail);
      return;
    case "recover":
      await commandRecover(rest, fail);
      return;
    case "service":
      await commandService(rest, fail);
      return;
    case "status":
      await commandStatus(rest, fail);
      return;
    case "lock-status":
      await commandLockStatus(rest, fail);
      return;
    case "doctor":
      await commandDoctor(rest, fail);
      return;
    default:
      fail(`unknown subcommand "${sub}"`, 2);
  }
}

// Boot only as the process entrypoint: importing helpers for unit tests must
// not call process.exit (#545). Compare REALPATHS — Node leaves argv[1] as the
// install symlink while Bun resolves it, and a plain compare makes the
// documented Node bin a silent no-op.
if (isProcessMainModule(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `centraid-gateway: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(1);
  });
}

export function isProcessMainModule(
  argv1: string | undefined,
  moduleUrl: string | URL
): boolean {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const resolveReal = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return (
    resolveReal(path.resolve(argv1)) === resolveReal(fileURLToPath(moduleUrl))
  );
}

export { parseServeArgsPure, timingSafeTokenEqual } from "./cli-serve-args.js";
