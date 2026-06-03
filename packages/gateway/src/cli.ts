#!/usr/bin/env node
/*
 * `centraid-gateway` — standalone daemon for the centraid gateway.
 *
 * The same `serve()` the Electron desktop embeds, wrapped with:
 *   - JSON config file (`--config <path>`)
 *   - persistent shared bearer token (`<dataDir>/token.bin`)
 *   - SIGINT / SIGTERM graceful shutdown
 *
 * v0 PoC scope per centraid#131: loopback or LAN bind, no TLS, single
 * shared token. Per-device tokens, tunneling, and TLS termination are
 * documented out-of-scope follow-ups.
 *
 * Subcommands:
 *   centraid-gateway serve [--config <path>] [--data-dir <path>] [--host <h>] [--port <p>]
 *   centraid-gateway print-token --data-dir <path>
 *   centraid-gateway --help
 *   centraid-gateway --version
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { serve } from './serve.js';
import { daemonLayoutFor, type DaemonLayout } from './cli-paths.js';
import {
  loadConfigFile,
  validateConfig,
  type DaemonConfig,
  DaemonConfigError,
} from './cli-config.js';
import { readOrMintToken, readPersistedToken } from './cli-token.js';
import { seedRunnerPrefs } from './cli-runner-prefs.js';

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

function usage(): never {
  process.stderr.write(
    [
      'Usage:',
      '  centraid-gateway serve [--config <path>] [--data-dir <path>] [--host <h>] [--port <p>]',
      '  centraid-gateway print-token --data-dir <path>',
      '  centraid-gateway --version',
      '  centraid-gateway --help',
      '',
      'serve flags override the config file. --data-dir is required if no',
      '--config is supplied (the config file otherwise carries dataDir).',
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
  let cfg: DaemonConfig;
  if (parsed.configPath) {
    try {
      cfg = await loadConfigFile(parsed.configPath);
    } catch (err) {
      if (err instanceof DaemonConfigError) fail(err.message, 2);
      throw err;
    }
  } else if (parsed.dataDir) {
    cfg = validateConfig({ dataDir: parsed.dataDir });
  } else {
    fail('one of --config or --data-dir is required', 2);
  }
  // CLI overrides
  if (parsed.dataDir) cfg.dataDir = parsed.dataDir;
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

  const handle = await serve({
    paths: layout,
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
    token,
    logTag: 'centraid-gateway',
  });

  // Seed runner prefs *after* serve() so the gateway DB has been
  // migrated and `UserStore` can open it. setPrefs runs in a single
  // BEGIN IMMEDIATE so re-seed on every boot is safe.
  try {
    seedRunnerPrefs(handle.userStore, config);
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
    await handle.close().catch((err) => {
      process.stderr.write(
        `[centraid-gateway] close error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
