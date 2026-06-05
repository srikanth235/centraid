import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import url from 'node:url';
import { validateConfig, DaemonConfigError } from './config.ts';
import { buildPrefsPatch, seedRunnerPrefs } from './runner-prefs.ts';
import type { UserStore } from '@centraid/app-engine';
import { daemonLayoutFor } from './paths.ts';
import { readOrMintToken, readPersistedToken } from './token.ts';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const CLI_TS = path.resolve(here, 'cli.ts');
const TSX_BIN = path.resolve(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `centraid-gateway-${crypto.randomUUID()}-`));
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
  } as unknown as UserStore;
  seedRunnerPrefs(fakeStore, { dataDir: '/x' });
  expect(patches.length).toBe(1);
  for (const v of Object.values(patches[0]!)) expect(v).toBe(null);
});

test('daemonLayoutFor resolves relative paths to absolute', () => {
  const layout = daemonLayoutFor('./relative');
  expect(path.isAbsolute(layout.appsDir)).toBeTruthy();
  expect(layout.appsDir.endsWith(path.join('relative', 'apps'))).toBeTruthy();
});

test('readOrMintToken creates a 64-hex token on first call and re-reads it on the second', async () => {
  const tokenFile = path.join(dataDir, 'token.bin');
  const a = await readOrMintToken(tokenFile);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  const b = await readOrMintToken(tokenFile);
  expect(a).toBe(b);
  const persisted = await readPersistedToken(tokenFile);
  expect(persisted).toBe(a);
});

// End-to-end: spawn the CLI via tsx, parse "listening on …" + "token: …"
// out of stdout, hit /centraid/_apps with the token, assert 200, send
// SIGTERM, confirm clean exit. This proves the binary boots, listens,
// honors the bearer, and shuts down cleanly — the v0 PoC contract.
test('serve subcommand boots, accepts the printed bearer, and exits cleanly on SIGTERM', async (t) => {
  // Skip if tsx isn't installed locally — the gate is `bun install` having
  // run at the monorepo root, not on every developer's machine.
  try {
    await fs.stat(TSX_BIN);
  } catch {
    t.skip(`tsx not found at ${TSX_BIN} — run "bun install" at the monorepo root`);
    return;
  }
  const child = spawn(
    TSX_BIN,
    [CLI_TS, 'serve', '--data-dir', dataDir, '--host', '127.0.0.1', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b.toString();
  });
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });

  // Wait until the listening + token lines have been printed.
  const { url, token } = await new Promise<{ url: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout; stderr=${stderr}`)), 15_000);
    const check = (): void => {
      const urlMatch = stdout.match(/listening on (http:\/\/[^\s]+)/);
      const tokenMatch = stdout.match(/token:\s+([0-9a-f]{64})/);
      if (urlMatch && tokenMatch) {
        clearTimeout(timer);
        resolve({ url: urlMatch[1]!, token: tokenMatch[1]! });
      }
    };
    child.stdout.on('data', check);
    check();
  });

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
