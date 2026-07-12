#!/usr/bin/env node
/*
 * `centraid-gateway` — standalone daemon for the centraid gateway.
 *
 * The same `serve()` the Electron desktop embeds, wrapped with:
 *   - JSON config file (`--config <path>`)
 *   - persistent shared bearer token (`<dataDir>/token.bin`)
 *   - SIGINT / SIGTERM graceful shutdown
 *
 * v0 PoC scope per centraid#131: loopback or LAN bind, no TLS. The shared
 * bearer token is the ADMIN plane; per-device HTTP tokens (issue #376,
 * minted by `pair`/`devices add` + `POST /centraid/_gateway/pair`) are the
 * TENANT plane, confined to their device's vault enrollments. TLS
 * termination stays a documented out-of-scope follow-up (front with
 * Caddy / Tailscale Funnel / Cloudflare Tunnel).
 *
 * Subcommands:
 *   centraid-gateway serve [--config <path>] [--data-dir <path>] [--host <h>] [--port <p>]
 *   centraid-gateway print-token --data-dir <path>
 *   centraid-gateway vault <list|create|rename|delete> --data-dir <path> …   (admin plane, #289)
 *   centraid-gateway pair --data-dir <path> [--vault <name-or-id>] [--ttl-minutes <n>]
 *   centraid-gateway devices <list|add|revoke> --data-dir <path> …
 *   centraid-gateway key <status|export|restore|rotate> --data-dir <path> …  (custody, #298)
 *   centraid-gateway service <install|uninstall|status> …                    (OS service unit, #351)
 *   centraid-gateway --help
 *   centraid-gateway --version
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BearerAuthorization } from '@centraid/app-engine';
import { serve } from '../serve/serve.js';
import { daemonLayoutFor, type DaemonLayout } from './paths.js';
import { type DaemonConfig } from './config.js';
import { resolveDaemonConfig } from './resolve-config.js';
import { readOrMintToken, readPersistedToken } from './token.js';
import { seedRunnerPrefs } from './runner-prefs.js';
import { commandVault } from './vault-admin.js';
import { commandDevices, commandPair } from './device-admin.js';
import { commandKey } from './key-admin.js';
import { commandBackup } from './backup-admin.js';
import { commandService } from './service-admin.js';
import { makeDaemonDevicePlane } from './endpoint-host.js';

const PKG_VERSION = '0.1.0';

interface ParsedServe {
  configPath?: string;
  dataDir?: string;
  host?: string;
  port?: number;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`centraid-gateway: ${message}\n`);
  process.exit(code);
}

/** Constant-time string compare — same posture as app-engine's bearer check. */
function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function usage(): never {
  process.stderr.write(
    [
      'Usage:',
      '  centraid-gateway serve [--config <path>] [--data-dir <path>] [--host <h>] [--port <p>]',
      '  centraid-gateway print-token --data-dir <path>',
      '  centraid-gateway vault list --data-dir <path>',
      '  centraid-gateway vault create --data-dir <path> [--name <name>]',
      '  centraid-gateway vault rename --data-dir <path> <vaultId> <name>',
      '  centraid-gateway vault delete --data-dir <path> <vaultId>',
      '  centraid-gateway pair --data-dir <path> [--vault <name-or-id>] [--ttl-minutes <n>]',
      '  centraid-gateway devices list --data-dir <path> [--vault <name-or-id>]',
      '  centraid-gateway devices add --data-dir <path> <endpoint-id> --vault <name-or-id> [--label <l>]',
      '  centraid-gateway devices revoke --data-dir <path> <enrollment-or-endpoint-id>',
      '  centraid-gateway key status  --data-dir <path> --vault <name-or-id>',
      '  centraid-gateway key export  --data-dir <path> --vault <name-or-id> --out <file>',
      '  centraid-gateway key restore --data-dir <path> --vault <name-or-id> --from <file>',
      '  centraid-gateway key rotate  --data-dir <path> --vault <name-or-id>',
      '  centraid-gateway backup status  [--config <path> | --data-dir <path>]',
      '  centraid-gateway backup run     [--config <path> | --data-dir <path>] [--vault <id>]',
      '  centraid-gateway backup list    [--config <path> | --data-dir <path>] [--vault <id>]',
      '  centraid-gateway backup verify  [--config <path> | --data-dir <path>] [--vault <id>]',
      '  centraid-gateway backup restore [--config <path> | --data-dir <path>] --vault <id> --dest <dir> [--seq <n>]',
      '  centraid-gateway backup kit     [--config <path> | --data-dir <path>] --out <file>',
      '  centraid-gateway service install   [--data-dir <path> | --config <path>] [--host <h>] [--port <p>] [--dry-run] [--label <id>]',
      '  centraid-gateway service uninstall [--dry-run] [--label <id>]',
      '  centraid-gateway service status    [--dry-run] [--label <id>]',
      '  centraid-gateway --version',
      '  centraid-gateway --help',
      '',
      'vault/pair/devices/key are the ADMIN plane (issue #289): vault',
      'lifecycle, pairing tickets, device enrollment and seal-key custody',
      'are landlord acts guarded by shell access to this box — they never',
      'ride HTTP. key export/restore are the recovery story for sealed',
      'secrets (issue #298): copying a vault directory carries ciphertext',
      'only; the key travels ONLY through these receipted gestures.',
      '',
      'A ticket minted by `pair` also redeems over plain HTTP (POST',
      '/centraid/_gateway/pair, issue #376) for a device that cannot dial',
      'the iroh endpoint directly — it enrolls the caller and mints it a',
      'per-device HTTP bearer token, confined to that device\'s vaults the',
      'same way an iroh-proved caller is. The printed token above (serve /',
      'print-token) stays the unrestricted ADMIN plane; never hand it to a',
      'device you mean to confine.',
      '',
      'backup is the offsite engine (PROTOCOL.md/FORMAT.md), config from the',
      'same --config/--data-dir resolution `serve` uses (its JSON config',
      'file\'s "backup" key). restore materializes into --dest — it never',
      'swaps the live vault; kit emits live key material, store it offline.',
      '',
      'serve flags override the config file. --data-dir is required if no',
      '--config is supplied (the config file otherwise carries dataDir).',
      '',
      'service install/uninstall/status generate and manage a real OS service',
      'unit for the headless daemon — a macOS LaunchAgent (launchctl) or a',
      'systemd --user unit — so it survives a reboot and restarts on crash',
      '(issue #351). install writes the unit pointing `serve` at the SAME',
      '--data-dir/--config it was given; --dry-run prints the unit and the',
      'commands without writing or running anything.',
      '',
      'Bind defaults to 127.0.0.1:0 (loopback, OS-assigned port). Pass',
      '--host 0.0.0.0 to bind LAN-reachable interfaces. There is no TLS',
      'terminator in v0; front with Caddy / Tailscale Funnel / Cloudflare',
      'Tunnel if exposing beyond a trusted LAN.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

function parseServeArgs(args: string[]): ParsedServe {
  const out: ParsedServe = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`flag "${flag}" requires a value`, 2);
      return v;
    };
    switch (flag) {
      case '--config':
        out.configPath = next();
        break;
      case '--data-dir':
        out.dataDir = next();
        break;
      case '--host':
        out.host = next();
        break;
      case '--port': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 0 || n > 65535) {
          fail(`--port must be an integer in [0, 65535], got "${args[i]}"`, 2);
        }
        out.port = n;
        break;
      }
      case '--help':
      case '-h':
        usage();
        break;
      default:
        fail(`unknown flag "${flag}"`, 2);
    }
  }
  return out;
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

  const token = await readOrMintToken(layout.tokenFile);

  // Device plane (issue #289): enrollment-scoped vault resolution for
  // requests arriving over the iroh endpoint. Constructed before serve()
  // so its `deviceAccess` participates in every request; the endpoint
  // itself binds after the HTTP listener is up.
  const logger = {
    info: (msg: string) => process.stdout.write(`[centraid-gateway] ${msg}\n`),
    warn: (msg: string) => process.stderr.write(`[centraid-gateway] ${msg}\n`),
    error: (msg: string) => process.stderr.write(`[centraid-gateway] ${msg}\n`),
  };
  let vaultsRef: import('../serve/vault-registry.js').VaultRegistry | undefined;
  const devicePlane = makeDaemonDevicePlane({
    layout,
    vaults: () => vaultsRef,
    logger,
  });

  // Per-device HTTP bearer tokens (issue #376): the shared token remains
  // the landlord/admin plane (unrestricted — every vault); a presented
  // `cdt_...` token resolves through `DeviceTokenStore` to its device key
  // and gets confined to that device's enrollments exactly like an
  // iroh-proved request (`build-gateway.ts`'s `composedHandler`).
  const authorizeBearer = (bearer: string): BearerAuthorization | undefined => {
    if (timingSafeTokenEqual(bearer, token)) return { plane: 'admin' };
    const device = devicePlane.pairing.deviceTokens.authorize(bearer);
    return device ? { plane: 'device', deviceKey: device.deviceKey } : undefined;
  };

  const handle = await serve({
    paths: layout,
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
    ...(config.backup ? { backup: config.backup } : {}),
    token,
    logTag: 'centraid-gateway',
    deviceAccess: devicePlane.deviceAccess,
    devicePairing: devicePlane.pairing,
    authorizeBearer,
  });
  vaultsRef = handle.vaults;

  // The iroh endpoint (issue #289 phase 3): the gateway's permanent
  // identity + the first-class remote transport. Best-effort — an HTTP-only
  // daemon still serves loopback/`direct` clients.
  const endpoint =
    config.endpoint === false
      ? undefined
      : await devicePlane.startEndpoint({
          baseUrl: handle.url,
          token,
        });
  if (endpoint) {
    process.stdout.write(`[centraid-gateway] endpoint: ${endpoint.endpointId}\n`);
  }

  // Seed runner prefs *after* serve(). The write is an atomic JSON
  // replace, so re-seed on every boot is safe.
  try {
    seedRunnerPrefs(handle.prefs, config);
  } catch (err) {
    process.stderr.write(
      `[centraid-gateway] warning: failed to seed runner prefs: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  process.stdout.write(
    `[centraid-gateway] listening on ${handle.url}\n[centraid-gateway] token: ${handle.token}\n[centraid-gateway] dataDir: ${path.resolve(config.dataDir)}\n`,
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    process.stderr.write(`[centraid-gateway] ${signal} received — shutting down\n`);
    await endpoint?.close().catch(() => undefined);
    await handle.close().catch((err) => {
      process.stderr.write(
        `[centraid-gateway] close error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
    process.exit(0);
  };
  process.on('SIGINT', (signal) => void shutdown(signal));
  process.on('SIGTERM', (signal) => void shutdown(signal));
}

async function commandPrintToken(args: string[]): Promise<void> {
  let dataDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir') {
      dataDir = args[++i];
    } else {
      fail(`unknown flag "${args[i]}"`, 2);
    }
  }
  if (!dataDir) fail('--data-dir is required', 2);
  const layout: DaemonLayout = daemonLayoutFor(dataDir);
  const token = await readPersistedToken(layout.tokenFile);
  if (!token) fail(`no token at ${layout.tokenFile} — run "centraid-gateway serve" first`, 1);
  process.stdout.write(`${token}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [sub, ...rest] = argv;
  if (sub === '--version' || sub === '-v') {
    process.stdout.write(`${PKG_VERSION}\n`);
    return;
  }
  if (!sub || sub === '--help' || sub === '-h') usage();
  switch (sub) {
    case 'serve':
      await commandServe(rest);
      return;
    case 'print-token':
      await commandPrintToken(rest);
      return;
    case 'vault':
      await commandVault(rest, fail);
      return;
    case 'pair':
      await commandPair(rest, fail);
      return;
    case 'devices':
      await commandDevices(rest, fail);
      return;
    case 'key':
      await commandKey(rest, fail);
      return;
    case 'backup':
      await commandBackup(rest, fail);
      return;
    case 'service':
      await commandService(rest, fail);
      return;
    default:
      fail(`unknown subcommand "${sub}"`, 2);
  }
}

main().catch((err) => {
  process.stderr.write(
    `centraid-gateway: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
