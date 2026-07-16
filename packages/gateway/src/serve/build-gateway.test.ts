import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { buildGateway, type BuiltGateway } from './build-gateway.ts';
import type { GatewayPaths } from '../paths.ts';

// `buildGateway()` is the host-agnostic core: it constructs the whole
// object graph but binds no socket. These tests pin that contract — the
// listener-free shape, plus `composedHandler` dispatching the gateway's
// route chain WITHOUT a bearer check (for hosts that own auth themselves).

let dataDir: string;
let gateway: BuiltGateway;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, 'vault'),
    prefsFile: path.join(dir, 'prefs.json'),
  };
}

/** Mount a handler on a bare loopback server with no auth in front. */
async function mountUnauthed(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no bound address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `build-gateway-${crypto.randomUUID()}-`));
  gateway = await buildGateway({ paths: pathsUnder(dataDir) });
});

afterEach(async () => {
  await gateway.stop().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('constructs the graph and exposes the lifecycle without binding a socket', () => {
  expect(gateway.runtime).toBeTruthy();
  expect(gateway.prefs).toBeTruthy();
  expect(gateway.analyticsStore).toBeTruthy();
  expect(gateway.conversationHistoryStore).toBeTruthy();
  expect(typeof gateway.start).toBe('function');
  expect(typeof gateway.stop).toBe('function');
  expect(Array.isArray(gateway.extraHandlers)).toBeTruthy();
  expect(typeof gateway.composedHandler).toBe('function');
  // No listener bound — nothing in the handle resembles a URL/token.
  expect((gateway as unknown as Record<string, unknown>).url).toBe(undefined);
  expect((gateway as unknown as Record<string, unknown>).token).toBe(undefined);
});

test('mounts the vault registry and recovers it across rebuilds (#280)', async () => {
  // The registry is mandatory now — the whole app world is vault-scoped.
  expect(gateway.vaults).toBeDefined();
  expect(gateway.vaults.current().boot.fresh).toBe(true);
  expect(gateway.vaults.list()).toHaveLength(1);
  // The owner consent surface answers through the composed chain.
  const mounted = await mountUnauthed(gateway.composedHandler);
  try {
    const status = await (await fetch(`${mounted.url}/centraid/_vault/status`)).json();
    expect(status).toMatchObject({
      vaultId: gateway.vaults.current().boot.vaultId,
    });
  } finally {
    await mounted.close();
  }

  // A rebuild over the same paths recovers the same vault, not a new one.
  const again = await buildGateway({ paths: pathsUnder(dataDir) });
  try {
    expect(again.vaults.current().boot.fresh).toBe(false);
    expect(again.vaults.current().boot.vaultId).toBe(gateway.vaults.current().boot.vaultId);
    expect(gateway.vaults.current().walShipper).toBeDefined();
    expect(again.vaults.current().walShipper).toBeUndefined();
  } finally {
    await again.stop();
  }
});

test('the active vault owns a code store — activeAppsStore materializes it', async () => {
  const store = await gateway.appsStore();
  expect(store).toBeTruthy();
  // The store lives INSIDE the active vault's directory (#280).
  const vaultId = gateway.vaults.current().boot.vaultId;
  expect(store.getActiveMainLink().startsWith(path.join(dataDir, 'vault', vaultId, 'code'))).toBe(
    true,
  );
});

test('composedHandler dispatches runtime routes with NO bearer check', async () => {
  await gateway.start('http://127.0.0.1:0');
  const srv = await mountUnauthed(gateway.composedHandler);
  try {
    // No Authorization header — a fronting host owns auth itself, so
    // the composed chain must serve the request, not 401 it.
    const res = await fetch(`${srv.url}/centraid/_apps`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  } finally {
    await srv.close();
  }
});

test('composedHandler routes the chat-history + prefs prefixes', async () => {
  await gateway.start('http://127.0.0.1:0');
  const srv = await mountUnauthed(gateway.composedHandler);
  try {
    // Both prefixes resolve to their store handlers (not the runtime
    // fall-through) — proving the chat → prefs → extra → runtime order.
    const chat = await fetch(`${srv.url}/_centraid-user/prefs`);
    expect(chat.status).not.toBe(404);
    // `/id` answers with the ACTIVE vault's owner party id (#280).
    const id = (await (await fetch(`${srv.url}/_centraid-user/id`)).json()) as { id: string };
    expect(id.id).toBe(gateway.vaults.current().boot.ownerPartyId);
  } finally {
    await srv.close();
  }
});

test('composedHandler serves the kit Ask panel model picker (GET/PUT /centraid/<appId>/_turn/model)', async () => {
  await gateway.start('http://127.0.0.1:0');
  await gateway.runtime.registry.ensureUploaded('demo');
  const srv = await mountUnauthed(gateway.composedHandler);
  try {
    // No override yet — `current` is null, no defaultModel (no prefs, no
    // catalog in this hermetic test — the CLI probe/warmer never runs).
    const before = (await (await fetch(`${srv.url}/centraid/demo/_turn/model`)).json()) as {
      runnerKind: string;
      current: string | null;
      catalog: unknown[];
    };
    expect(before.runnerKind).toBe('codex'); // prefsLoader's default when unset
    expect(before.current).toBeNull();
    expect(before.catalog).toEqual([]);

    // Setting the override writes the SAME `model.<kind>.ask` prefs key
    // `resolveSubsystemModel` reads at turn time — one source of truth.
    const putRes = await fetch(`${srv.url}/centraid/demo/_turn/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5-mini' }),
    });
    expect(putRes.status).toBe(200);
    expect(gateway.prefs.getAllPrefs()['model.codex.ask']).toBe('gpt-5.5-mini');

    const after = (await (await fetch(`${srv.url}/centraid/demo/_turn/model`)).json()) as {
      current: string | null;
    };
    expect(after.current).toBe('gpt-5.5-mini');

    // `model: null` clears the override back to default.
    const cleared = await fetch(`${srv.url}/centraid/demo/_turn/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: null }),
    });
    expect(((await cleared.json()) as { current: string | null }).current).toBeNull();
    expect(gateway.prefs.getAllPrefs()['model.codex.ask']).toBeUndefined();
  } finally {
    await srv.close();
  }
});

test('the ask model picker follows ask’s OWN runner pin, not the default agent', async () => {
  await gateway.start('http://127.0.0.1:0');
  await gateway.runtime.registry.ensureUploaded('demo');
  const srv = await mountUnauthed(gateway.composedHandler);
  try {
    // The default agent stays codex; only the `ask` register is re-pinned.
    gateway.prefs.setPrefs({ 'agent.runner.kind': 'codex', 'runner.ask': 'claude-code' });

    // GET reports ask's resolved runner — the picker must offer the models of
    // the backend the ask turn will actually run on.
    const info = (await (await fetch(`${srv.url}/centraid/demo/_turn/model`)).json()) as {
      runnerKind: string;
    };
    expect(info.runnerKind).toBe('claude-code');

    // ...and PUT writes THAT runner's key. Reading one key while writing
    // another is the exact bug per-subsystem resolution has to avoid.
    const putRes = await fetch(`${srv.url}/centraid/demo/_turn/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    expect(putRes.status).toBe(200);
    expect(gateway.prefs.getAllPrefs()['model.claude-code.ask']).toBe('claude-sonnet-4-6');
    // The default agent's key is untouched — no cross-runner bleed.
    expect(gateway.prefs.getAllPrefs()['model.codex.ask']).toBeUndefined();

    // The round-trip agrees: GET reads back what PUT wrote.
    const after = (await (await fetch(`${srv.url}/centraid/demo/_turn/model`)).json()) as {
      current: string | null;
    };
    expect(after.current).toBe('claude-sonnet-4-6');
  } finally {
    await srv.close();
  }
});

test('with no runner.* pins the ask picker still rides the default agent (back-compat)', async () => {
  await gateway.start('http://127.0.0.1:0');
  await gateway.runtime.registry.ensureUploaded('demo');
  const srv = await mountUnauthed(gateway.composedHandler);
  try {
    // Back-compat is the hard requirement: a prefs file that predates
    // per-subsystem selection carries only `agent.runner.kind`, and every
    // register must resolve to it exactly as it did before.
    gateway.prefs.setPrefs({ 'agent.runner.kind': 'claude-code' });

    const info = (await (await fetch(`${srv.url}/centraid/demo/_turn/model`)).json()) as {
      runnerKind: string;
    };
    expect(info.runnerKind).toBe('claude-code');
  } finally {
    await srv.close();
  }
});

test('start() activates the vault workspace so its apps dir exists', async () => {
  await gateway.start('http://127.0.0.1:0');
  const vaultId = gateway.vaults.current().boot.vaultId;
  const stat = await fs.stat(path.join(dataDir, 'vault', vaultId, 'apps'));
  expect(stat.isDirectory()).toBeTruthy();
});

test('serves component health through the composed chain', async () => {
  await gateway.start('http://127.0.0.1:0');
  // Host-pushed components (e.g. the desktop tunnel) join the aggregate.
  gateway.health.reportError('tunnel', 'iroh endpoint dial failed');
  const srv = await mountUnauthed(gateway.composedHandler);
  try {
    const body = (await (await fetch(`${srv.url}/centraid/_gateway/health`)).json()) as {
      status: string;
      components: Array<{ component: string; status: string; detail?: string }>;
      recentEvents: Array<{ component: string; level: string; message: string }>;
    };
    expect(body.status).toBe('error');
    const byName = new Map(body.components.map((c) => [c.component, c]));
    // Wired-in probes: the boot vault mounted, no connections configured.
    expect(byName.get('vaults')).toMatchObject({ status: 'ok', detail: '1 vault mounted' });
    expect(byName.get('connections')).toMatchObject({ status: 'ok' });
    // Reconcile ran during start() and reported the scheduler healthy.
    expect(byName.get('automations')?.status).toBe('ok');
    // Wave 4 additions (issue #351): no enrichers installed, no s3 tier
    // configured on the boot vault — both read as a healthy, honest ok.
    expect(byName.get('enrichment')).toMatchObject({
      status: 'ok',
      detail: '0 of 0 enrichers enabled',
    });
    expect(byName.get('blob-sweep')?.status).toBe('ok');
    // The host-pushed failure carries its structured event.
    expect(byName.get('tunnel')).toMatchObject({
      status: 'error',
      lastError: 'iroh endpoint dial failed',
    });
    expect(body.recentEvents).toContainEqual(
      expect.objectContaining({ component: 'tunnel', level: 'error' }),
    );
  } finally {
    await srv.close();
  }
});

test('the disk component reports free space on the vault volume', async () => {
  await gateway.start('http://127.0.0.1:0');
  const srv = await mountUnauthed(gateway.composedHandler);
  try {
    const body = (await (await fetch(`${srv.url}/centraid/_gateway/health`)).json()) as {
      components: Array<{ component: string; status: string; detail?: string }>;
    };
    const disk = body.components.find((c) => c.component === 'disk');
    expect(disk?.status).toBe('ok');
    expect(disk?.detail).toContain('free of');
  } finally {
    await srv.close();
  }
});

test('the vaults probe proves readability — a broken DB handle flips it to error, named by vault id (#351)', async () => {
  await gateway.start('http://127.0.0.1:0');
  const plane = gateway.vaults.current();
  const vaultId = plane.boot.vaultId;
  // Simulate the file becoming unreadable underneath the process (disk
  // failure, external corruption) WITHOUT actually closing the handle —
  // that would double-close on teardown. The plane object stays "mounted"
  // in memory; only the trivial read the probe runs now fails.
  (plane.db.vault as unknown as { prepare: () => never }).prepare = () => {
    throw new Error('database disk image is malformed');
  };
  const srv = await mountUnauthed(gateway.composedHandler);
  try {
    const body = (await (await fetch(`${srv.url}/centraid/_gateway/health`)).json()) as {
      status: string;
      components: Array<{ component: string; status: string; detail?: string }>;
    };
    const vaults = body.components.find((c) => c.component === 'vaults');
    expect(vaults?.status).toBe('error');
    expect(vaults?.detail).toContain(vaultId);
    expect(body.status).toBe('error');
  } finally {
    await srv.close();
  }
});
