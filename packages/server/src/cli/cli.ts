#!/usr/bin/env node
/*
 * `centraid-gateway` — standalone daemon for the centraid gateway.
 *
 * The same `serve()` the Electron desktop embeds, wrapped with:
 *   - JSON config file (`--config <path>`)
 *   - a loopback bearer DERIVED FROM CUSTODY (issue #568 item J corrects the
 *     #505 phase 7 description): `HMAC(endpoint-key.bin,
 *     "centraid/landlord-http/v1")`. It is never written to disk as a token
 *     and never printed, but it is STABLE for the life of the endpoint
 *     identity and is not rotated — any local process that can open the
 *     gateway's KeyStore reproduces it, which is how the CLI and the desktop
 *     reach a daemon they did not spawn. A parent that DOES spawn this daemon
 *     may pin a per-launch value via the `CENTRAID_GATEWAY_TOKEN` env.
 *   - SIGINT / SIGTERM graceful shutdown
 *
 * v0 PoC scope per centraid#131: loopback or LAN bind, no TLS. Shared and
 * per-device HTTP credentials are retired. Remote access is iroh-only and
 * every request carries a cryptographically proved EndpointId resolved
 * through persisted vault enrollments. Filesystem maintenance commands take
 * gateway.db's exclusive lock and therefore refuse while the daemon runs.
 * TLS termination stays a documented out-of-scope follow-up.
 *
 * Subcommands:
 *   centraid-gateway serve [--config <path>] [--data-dir <path>] [--host <h>] [--port <p>]
 *   centraid-gateway vault <list|create|rename|delete> --data-dir <path> …   (offline maintenance)
 *   centraid-gateway pair [--config <path> | --data-dir <path>] [--port <p>] [--vault <name-or-id>] …
 *   centraid-gateway owners <list|add|rename|remove> --data-dir <path> …
 *   centraid-gateway devices <list|add|revoke> --data-dir <path> …
 *   centraid-gateway key <status|export|restore|rotate> --data-dir <path> …  (custody, #298)
 *   centraid-gateway service <install|uninstall|status> …                    (OS service unit, #351)
 *   centraid-gateway status [--data-dir <path> | --config <path>] [--json]   (issue #382)
 *   centraid-gateway --help
 *   centraid-gateway --version
 *
 * `--json` on `pair`/`vault list`/`vault create`/`status` (issue #382) swaps
 * the human text for a single machine-readable line. Every other
 * subcommand's output is unchanged.
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
      // Try the source-runner/built-package alternative.
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
  // CLI overrides
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

  // Loopback bearer (issue #505 phase 7, corrected by #568 item J). This is
  // the bearer the in-process iroh endpoint host forwards with when it hands a
  // proved iroh request to the loopback HTTP listener; forwarded requests also
  // carry the per-boot device proof header, so the real per-device identity is
  // what `composedHandler` scopes on (this bearer only unlocks the loopback
  // door). It is NOT per-boot: `landlordBearerForEndpointSecret` derives it
  // from the KeyStore-custodied endpoint key, so it is stable for the life of
  // that identity and is never rotated — that stability is what lets the CLI
  // and the desktop reach a daemon they did not spawn. A parent that DOES
  // spawn this daemon (the
  // desktop's detached gateway) may pin a per-launch value via
  // `CENTRAID_GATEWAY_TOKEN`.
  const dataPlaneSecret = process.env.CENTRAID_DATA_PLANE_SECRET;
  const dataPlaneHttpUrl = process.env.CENTRAID_DATA_PLANE_HTTP_URL;
  const desktopEndpointId =
    process.env.CENTRAID_DESKTOP_ENDPOINT_ID?.trim() || undefined;

  // Device plane (issue #289): enrollment-scoped vault resolution for
  // requests arriving over the iroh endpoint. Constructed before serve()
  // so its `deviceAccess` participates in every request; the endpoint
  // itself binds after the HTTP listener is up.
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
  // The daemon always has a host identity: it is the device the auto-founded
  // vaults are owned by (issue #603), and the identity `pair` mints against.
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

  // The ephemeral secret opens only the process-local HTTP listener. Device
  // authorization still resolves through a real EndpointId enrollment: iroh
  // proof normally, or the spawning desktop's OS-custodied identity.
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
    // Durable PWA control sessions (issue #376): persist control cookies so
    // a web pairing survives a restart, and propagate `devices revoke` to
    // live cookies via the SAME enrollment store the endpoint admits from.
    webSessions: {
      controlStore: WebControlSessionStore.open(gatewayDatabase),
      isDeviceValid: (key) => devicePlane.pairing.enrollments.isEnrolled(key),
    },
    ...(webRoot
      ? {
          web: {
            rootDir: webRoot,
            ...(config.host ? { host: config.host } : {}),
            // The web UI rides on the API port + 1. If that derived port is
            // already taken, `startWebUiServer` degrades gracefully — it falls
            // back to an ephemeral port instead of rejecting — so a web-port
            // collision can never take down the gateway's API. `handle.webUrl`
            // (printed below) reflects the real listening port.
            ...(config.port !== undefined && config.port < 65_535
              ? { port: config.port === 0 ? 0 : config.port + 1 }
              : {}),
          },
        }
      : {}),
  });
  vaultsRef = handle.vaults;

  // The iroh endpoint (issue #289 phase 3): the gateway's permanent
  // identity + the only remote transport. Best-effort so the loopback
  // maintenance surface can still start when iroh is temporarily unavailable.
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

  // Seed harness prefs *after* serve(). The write is an atomic JSON
  // replace, so re-seed on every boot is safe.
  try {
    seedHarnessPrefs(handle.prefs, config);
  } catch (error) {
    process.stderr.write(
      `[centraid-gateway] warning: failed to seed harness prefs: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }

  // The loopback secret is deliberately NOT printed (issue #505 phase 7) — it
  // is ephemeral in-process plumbing, not a credential to paste anywhere.
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

// Only boot when this file is the process entrypoint (tsx/node/bin). Importing
// pure helpers for unit tests (issue #545 B7) must not call process.exit.
// Node realpaths the ESM main for import.meta.url but leaves argv[1] as the
// install symlink (node_modules/.bin/centraid-gateway); Bun realpaths both.
// Compare realpaths so the documented Node bin is not a silent no-op (#545).
if (isProcessMainModule(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `centraid-gateway: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(1);
  });
}

/** True when argv[1] is this module after resolving install symlinks. */
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
