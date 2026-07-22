import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';
import { validateConfig, DaemonConfigError } from './config.ts';
import { buildPrefsPatch, seedRunnerPrefs } from './runner-prefs.ts';
import type { PrefsStore } from '@centraid/app-engine';
import { daemonLayoutFor } from './paths.ts';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const CLI_TS = path.resolve(here, 'cli.ts');
const TSX_BIN = path.resolve(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');

let dataDir: string;

beforeEach(async () => {
  dataDir = await tempDir(`centraid-gateway-${crypto.randomUUID()}-`);
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('validateConfig rejects missing dataDir', () => {
  expect(() => validateConfig({})).toThrow(DaemonConfigError);
});

test('validateConfig rejects out-of-range port', () => {
  expect(() => validateConfig({ dataDir: '/tmp/x', port: 99999 })).toThrow(/must be an integer/);
});

test('validateConfig accepts a minimal config and a fully populated one', () => {
  expect(validateConfig({ dataDir: '/tmp/x' })).toEqual({ dataDir: '/tmp/x' });
  const full = validateConfig({
    dataDir: '/tmp/x',
    host: '0.0.0.0',
    port: 8765,
    runner: { kind: 'codex', binPath: '/opt/bin/codex', extraArgs: ['--foo'] },
  });
  expect(full.runner?.kind).toBe('codex');
  expect(full.runner?.binPath).toBe('/opt/bin/codex');
});

test('buildPrefsPatch clears every runner key when no runner is configured', () => {
  const patch = buildPrefsPatch({ dataDir: '/x' });
  // No runner → every key must clear to null so a removed entry in the
  // config file actually wipes the DB.
  for (const v of Object.values(patch)) expect(v).toBe(null);
});

test('buildPrefsPatch sets only the keys the config carries', () => {
  const patch = buildPrefsPatch({
    dataDir: '/x',
    runner: { kind: 'claude-code' },
  });
  expect(patch['agent.runner.kind']).toBe('claude-code');
  expect(patch['agent.runner.binPath']).toBe(null);
  expect(patch['agent.runner.extraArgs']).toBe(null);
});

test('seedRunnerPrefs calls setPrefs even on empty config so a removed runner is cleared', () => {
  // Regression: an early `if (!runner) return` would skip setPrefs entirely
  // when the block is absent, leaving a previously seeded `agent.runner.*`
  // row stale across reboots.
  const patches: Array<Record<string, unknown>> = [];
  const fakeStore = {
    setPrefs(p: Record<string, unknown>) {
      patches.push(p);
      return p;
    },
  } as unknown as PrefsStore;
  seedRunnerPrefs(fakeStore, { dataDir: '/x' });
  expect(patches.length).toBe(1);
  for (const v of Object.values(patches[0]!)) expect(v).toBe(null);
});

test('daemonLayoutFor resolves relative paths to absolute', () => {
  const layout = daemonLayoutFor('./relative');
  expect(path.isAbsolute(layout.prefsFile)).toBeTruthy();
  expect(layout.prefsFile.endsWith(path.join('relative', 'prefs.json'))).toBeTruthy();
});

test('daemonLayoutFor mounts the vault plane at <dataDir>/vault', () => {
  // The daemon is a real host (duaility §12): a missing vaultDir would
  // leave every projection blueprint dark with "no vault plane mounted".
  const layout = daemonLayoutFor('./relative');
  expect(layout.vaultDir.endsWith(path.join('relative', 'vault'))).toBeTruthy();
});

// End-to-end: spawn the CLI via tsx, parse "listening on …" out of stdout,
// hit /centraid/_apps with the loopback secret, assert 200, send SIGTERM,
// confirm clean exit. Issue #505 phase 7 retired the persistent `token.bin`
// and stopped PRINTING any bearer — the daemon mints an ephemeral per-boot
// loopback secret instead. A parent (here the test, mirroring the desktop's
// detached-gateway spawn) pins a known value via `CENTRAID_GATEWAY_TOKEN` so
// it can reach the loopback listener; the secret is never written to disk.
test('serve subcommand boots, accepts the parent-supplied loopback secret, and exits cleanly on SIGTERM', async (t) => {
  // Skip if tsx isn't installed locally — the gate is `bun install` having
  // run at the monorepo root, not on every developer's machine.
  try {
    await fs.stat(TSX_BIN);
  } catch {
    t.skip(`tsx not found at ${TSX_BIN} — run "bun install" at the monorepo root`);
    return;
  }
  const token = crypto.randomBytes(32).toString('hex');
  const child = spawn(
    TSX_BIN,
    [CLI_TS, 'serve', '--data-dir', dataDir, '--host', '127.0.0.1', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CENTRAID_GATEWAY_TOKEN: token } },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b.toString();
  });
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });

  // Wait until the listening line has been printed. The bearer is NOT printed
  // (phase 7) — the parent already knows it (it supplied CENTRAID_GATEWAY_TOKEN).
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout; stderr=${stderr}`)), 15_000);
    const check = (): void => {
      const urlMatch = stdout.match(/listening on (http:\/\/[^\s]+)/);
      if (urlMatch) {
        clearTimeout(timer);
        resolve(urlMatch[1]!);
      }
    };
    child.stdout.on('data', check);
    check();
  });

  // The ephemeral secret must never leak to stdout.
  expect(stdout).not.toContain(token);
  expect(stdout).not.toMatch(/token:/);

  try {
    const ok = await fetch(`${url}/centraid/_apps`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as unknown[];
    expect(body).toEqual([]);

    const unauth = await fetch(`${url}/centraid/_apps`);
    expect(unauth.status).toBe(401);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }

  expect(stderr).toMatch(/SIGTERM received/);
});
