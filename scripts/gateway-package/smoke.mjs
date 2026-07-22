#!/usr/bin/env node
/**
 * Packaged-gateway install smoke (issue #504 packaging Phase B).
 *
 * External observer: starts an isolated data dir, hits /centraid/_gateway/info,
 * dumps logs on failure. Does not branch product main on "is smoke".
 *
 * Usage:
 *   node scripts/gateway-package/smoke.mjs [--gateway-bin <path>] [--port 0]
 *
 * Prefer an already-built gateway:
 *   bun run --cwd packages/gateway build
 *   node scripts/gateway-package/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INFO = '/centraid/_gateway/info';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'centraid-gw-smoke-'));
const port = Number(arg('--port', '0'));
const host = '127.0.0.1';
const gatewayBin =
  arg('--gateway-bin', null) ?? path.join(root, 'packages/gateway/dist/cli/cli.js');

// Prefer bun/ts source runner when dist missing.
const useBunSrc = !path.basename(gatewayBin).endsWith('.js') || gatewayBin.includes('cli.ts');

async function main() {
  mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(dataDir, 'smoke.log');
  const child = spawn(
    useBunSrc && gatewayBin.endsWith('.ts') ? 'bun' : process.execPath,
    useBunSrc && gatewayBin.endsWith('.ts')
      ? [gatewayBin, 'serve', '--data-dir', dataDir, '--host', host, '--port', String(port)]
      : [
          gatewayBin,
          'serve',
          '--data-dir',
          dataDir,
          '--host',
          host,
          '--port',
          String(port || 18787),
        ],
    {
      cwd: root,
      env: { ...process.env, CENTRAID_SMOKE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  child.stdout.on('data', (c) => {
    output += c.toString();
  });
  child.stderr.on('data', (c) => {
    output += c.toString();
  });

  let baseUrl = `http://${host}:${port || 18787}`;
  // Wait for listen line or timeout
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const m = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
    if (m) {
      baseUrl = m[0];
      break;
    }
    // try health even without parse
    try {
      const res = await fetch(`${baseUrl}${INFO}`);
      if (res.ok || res.status === 401) break;
    } catch {
      // not up yet
    }
    await sleep(200);
  }

  let ok = false;
  let detail = '';
  try {
    const res = await fetch(`${baseUrl}${INFO}`);
    const body = await res.json().catch(() => null);
    // info may require bearer on some configs; 200 or 401 both prove the listener
    ok = res.status === 200 || res.status === 401;
    detail = JSON.stringify({ status: res.status, body });
    if (res.status === 200 && body && typeof body.version !== 'string') ok = false;
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }

  child.kill('SIGTERM');
  await sleep(500);
  try {
    child.kill('SIGKILL');
  } catch {
    // already dead
  }

  writeFileSync(logPath, output);
  if (!ok) {
    process.stderr.write(
      `gateway smoke FAILED\nurl=${baseUrl}\n${detail}\n--- logs ---\n${output}\n`,
    );
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  }
  process.stdout.write(`gateway smoke OK ${baseUrl} ${detail}\n`);
  rmSync(dataDir, { recursive: true, force: true });
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
