import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import url from 'node:url';
import { validateConfig, DaemonConfigError } from './cli-config.ts';
import { buildPrefsPatch, seedRunnerPrefs } from './cli-runner-prefs.ts';
import type { UserStore } from '@centraid/runtime-core';
import { daemonLayoutFor } from './cli-paths.ts';
import { readOrMintToken, readPersistedToken } from './cli-token.ts';
import { makeFileSecretsProvider, writeProviderApiKey } from './cli-secrets.ts';

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
  assert.throws(() => validateConfig({}), DaemonConfigError);
});

test('validateConfig rejects out-of-range port', () => {
  assert.throws(() => validateConfig({ dataDir: '/tmp/x', port: 99999 }), /must be an integer/);
});

test('validateConfig accepts a minimal config and a fully populated one', () => {
  assert.deepEqual(validateConfig({ dataDir: '/tmp/x' }), { dataDir: '/tmp/x' });
  const full = validateConfig({
    dataDir: '/tmp/x',
    host: '0.0.0.0',
    port: 8765,
    runner: { kind: 'codex', binPath: '/opt/bin/codex', extraArgs: ['--foo'] },
    provider: {
      id: 'p',
      baseUrl: 'http://x',
      name: 'P',
      wireApi: 'chat',
      envKey: 'P_KEY',
      apiKey: 'sk-x',
    },
  });
  assert.equal(full.runner?.kind, 'codex');
  assert.equal(full.provider?.id, 'p');
});

test('validateConfig rejects provider.apiKey without provider.envKey', () => {
  // apiKey without envKey would silently persist the key to disk while
  // resolveProvider() inside serve() skips the key lookup — every
  // request would go out unauthenticated.
  assert.throws(
    () =>
      validateConfig({
        dataDir: '/tmp/x',
        provider: { id: 'p', baseUrl: 'http://x', apiKey: 'sk-x' },
      }),
    /requires `provider.envKey`/,
  );
});

test('buildPrefsPatch clears every runner key when no runner/provider is configured', () => {
  const patch = buildPrefsPatch({ dataDir: '/x' });
  // No runner / provider → every key must clear to null so a removed
  // entry in the config file actually wipes the DB.
  for (const v of Object.values(patch)) assert.equal(v, null);
});

test('buildPrefsPatch sets only the keys the config carries', () => {
  const patch = buildPrefsPatch({
    dataDir: '/x',
    runner: { kind: 'claude-code' },
    provider: { id: 'p', baseUrl: 'http://x' },
  });
  assert.equal(patch['agent.runner.kind'], 'claude-code');
  assert.equal(patch['agent.runner.binPath'], null);
  assert.equal(patch['agent.runner.provider.id'], 'p');
  assert.equal(patch['agent.runner.provider.baseUrl'], 'http://x');
  assert.equal(patch['agent.runner.provider.name'], null);
});

test('seedRunnerPrefs calls setPrefs even on empty config so a removed provider is cleared', () => {
  // Regression: the early `if (!runner && !provider) return` previously
  // skipped setPrefs entirely when both blocks were absent, leaving a
  // previously seeded `agent.runner.provider.*` row stale across reboots.
  const patches: Array<Record<string, unknown>> = [];
  const fakeStore = {
    setPrefs(p: Record<string, unknown>) {
      patches.push(p);
      return p;
    },
  } as unknown as UserStore;
  seedRunnerPrefs(fakeStore, { dataDir: '/x' });
  assert.equal(
    patches.length,
    1,
    'setPrefs must be called even when config has no runner/provider',
  );
  for (const v of Object.values(patches[0]!)) assert.equal(v, null);
});

test('daemonLayoutFor resolves relative paths to absolute', () => {
  const layout = daemonLayoutFor('./relative');
  assert.ok(path.isAbsolute(layout.appsDir));
  assert.ok(layout.appsDir.endsWith(path.join('relative', 'apps')));
});

test('readOrMintToken creates a 64-hex token on first call and re-reads it on the second', async () => {
  const tokenFile = path.join(dataDir, 'token.bin');
  const a = await readOrMintToken(tokenFile);
  assert.match(a, /^[0-9a-f]{64}$/);
  const b = await readOrMintToken(tokenFile);
  assert.equal(a, b);
  const persisted = await readPersistedToken(tokenFile);
  assert.equal(persisted, a);
});

test('makeFileSecretsProvider returns undefined when no key file exists', async () => {
  const layout = daemonLayoutFor(dataDir);
  const secrets = makeFileSecretsProvider(layout.providerKeyFile);
  assert.equal(await secrets.getProviderApiKey(), undefined);
});

test('writeProviderApiKey + makeFileSecretsProvider round-trips a plaintext key', async () => {
  const layout = daemonLayoutFor(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await writeProviderApiKey(layout.providerKeyFile, 'sk-test-abc');
  const secrets = makeFileSecretsProvider(layout.providerKeyFile);
  assert.equal(await secrets.getProviderApiKey(), 'sk-test-abc');
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
  const child: ChildProcessWithoutNullStreams = spawn(
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
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as unknown[];
    assert.deepEqual(body, []);

    const unauth = await fetch(`${url}/centraid/_apps`);
    assert.equal(unauth.status, 401);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }

  assert.match(stderr, /SIGTERM received/);
});
