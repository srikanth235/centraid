#!/usr/bin/env node
/**
 * Packaged-gateway install smoke (issue #504 packaging Phase B).
 *
 * External observer: starts an isolated data dir (host mode), or probes an
 * already-running base URL (container mode). Hits /centraid/_gateway/info,
 * dumps logs on failure. Does not branch product main on "is smoke".
 *
 * Usage:
 *   node scripts/gateway-package/smoke.mjs [--gateway-bin <path>] [--port 0]
 *   node scripts/gateway-package/smoke.mjs --base-url http://127.0.0.1:8787
 *
 * Prefer an already-built gateway for host mode:
 *   bun run --cwd packages/gateway build
 *   node scripts/gateway-package/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { waitForGatewayInfo } from './probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const baseUrlArg = arg('--base-url', null);

async function probeOnly(baseUrl) {
  const result = await waitForGatewayInfo(baseUrl, { deadlineMs: 45_000 });
  if (!result.ok) {
    process.stderr.write(`gateway smoke FAILED\nurl=${baseUrl}\n${result.detail}\n`);
    process.exit(1);
  }
  process.stdout.write(`gateway smoke OK ${baseUrl} ${result.detail}\n`);
}

async function hostMode() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'centraid-gw-smoke-'));
  const port = Number(arg('--port', '0'));
  const host = '127.0.0.1';
  const gatewayBin =
    arg('--gateway-bin', null) ?? path.join(root, 'packages/gateway/dist/cli/cli.js');

  const useBunSrc = !path.basename(gatewayBin).endsWith('.js') || gatewayBin.includes('cli.ts');

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
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const m = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
    if (m) {
      baseUrl = m[0];
      break;
    }
    try {
      const early = await waitForGatewayInfo(baseUrl, { deadlineMs: 200, intervalMs: 50 });
      if (early.ok) break;
    } catch {
      // not up
    }
    await sleep(200);
  }

  const result = await waitForGatewayInfo(baseUrl, { deadlineMs: 10_000 });

  child.kill('SIGTERM');
  await sleep(500);
  try {
    child.kill('SIGKILL');
  } catch {
    // already dead
  }

  writeFileSync(logPath, output);
  if (!result.ok) {
    process.stderr.write(
      `gateway smoke FAILED\nurl=${baseUrl}\n${result.detail}\n--- logs ---\n${output}\n`,
    );
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  }
  process.stdout.write(`gateway smoke OK ${baseUrl} ${result.detail}\n`);
  rmSync(dataDir, { recursive: true, force: true });
}

async function main() {
  if (baseUrlArg) {
    await probeOnly(baseUrlArg);
    return;
  }
  await hostMode();
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
