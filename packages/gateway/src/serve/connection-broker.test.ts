import { tempDir } from '@centraid/test-kit/temp-dir';
// The connection broker (issue #304): token custody correctness. The three
// rot points each get a scenario — rotated pair persisted before use,
// single-flight refresh under concurrency, invalid_grant flips needs-auth
// with an owner-readable note while a 5xx stays transient (no flip).

import { afterEach, expect, test } from 'vitest';
import http from 'node:http';
import { openVaultPlane, type VaultPlane } from './vault-plane.js';
import { ConnectionBroker } from './connection-broker.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
function openPlane(dir: string): VaultPlane {
  const plane = openVaultPlane({ dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => plane.stop());
  return plane;
}

interface TokenServer {
  url: string;
  requests: Array<Record<string, string>>;
  respond: (
    body: Record<string, unknown> | { status: number; body: Record<string, unknown> },
  ) => void;
}

/** A token endpoint that accepts the connection but never answers — simulates a wedged IdP. */
async function startHangingTokenServer(): Promise<{ url: string }> {
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer(() => {
    /* never respond */
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/token` };
}

/** A scriptable token endpoint: push one response per expected request. */
async function startTokenServer(): Promise<TokenServer> {
  const responses: Array<{ status: number; body: Record<string, unknown> }> = [];
  const requests: Array<Record<string, string>> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString();
    });
    req.on('end', () => {
      requests.push(Object.fromEntries(new URLSearchParams(raw)));
      const next = responses.shift() ?? { status: 500, body: { error: 'unscripted' } };
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/token`,
    requests,
    respond: (r) =>
      responses.push(
        'status' in r && typeof r.status === 'number'
          ? (r as { status: number; body: Record<string, unknown> })
          : { status: 200, body: r as Record<string, unknown> },
      ),
  };
}

function configureOauth(
  plane: VaultPlane,
  tokenUrl: string,
  over: Record<string, unknown> = {},
): string {
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'sync.configure_credential',
    input: {
      kind: 'pull.gmail',
      label: 'personal',
      cred_kind: 'oauth2',
      provider: 'google',
      auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_url: tokenUrl,
      client_id: 'cid.apps.googleusercontent.com',
      client_secret: 'GOCSPX-broker-test',
      allowed_hosts: ['gmail.googleapis.com'],
      ...over,
    },
    purpose: 'dpv:ServiceProvision',
  });
  if (outcome.status !== 'executed')
    throw new Error(`configure failed: ${JSON.stringify(outcome)}`);
  return (outcome as { output: { connection_id: string } }).output.connection_id;
}

function storeTokens(
  plane: VaultPlane,
  connectionId: string,
  input: Record<string, unknown>,
): void {
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'sync.store_tokens',
    input: { connection_id: connectionId, ...input },
    purpose: 'dpv:ServiceProvision',
  });
  if (outcome.status !== 'executed') throw new Error(`store failed: ${JSON.stringify(outcome)}`);
}

function connectionRow(plane: VaultPlane, connectionId: string): Record<string, unknown> {
  return plane.db.vault
    .prepare(
      `SELECT c.status, h.auth_note, cc.access_token, cc.refresh_token
         FROM sync_connection c
         LEFT JOIN sync_connection_credential cc ON cc.connection_id = c.connection_id
         LEFT JOIN sync_connection_health h ON h.connection_id = c.connection_id
        WHERE c.connection_id = ?`,
    )
    .get(connectionId) as Record<string, unknown>;
}

test('api_key connections resolve to injectable values without any network', async () => {
  const plane = openPlane(await tempDir());
  plane.gateway.invoke(plane.ownerCredential, {
    command: 'sync.configure_credential',
    input: {
      kind: 'pull.github',
      label: 'personal',
      cred_kind: 'api_key',
      api_key: 'ghp_broker_live',
      allowed_hosts: ['api.github.com'],
    },
    purpose: 'dpv:ServiceProvision',
  });
  const broker = new ConnectionBroker(() => plane);
  const auth = await broker.resolveForFire({ kind: 'pull.github', label: 'personal' });
  expect(auth && 'values' in auth ? auth.values : undefined).toEqual({
    api_key: 'ghp_broker_live',
  });
  expect(auth && 'allowedHosts' in auth ? auth.allowedHosts : []).toEqual(['api.github.com']);
});

test('a connection without a broker credential resolves to undefined (harness-ambient lane)', async () => {
  const plane = openPlane(await tempDir());
  const broker = new ConnectionBroker(() => plane);
  expect(await broker.resolveForFire({ kind: 'pull.gmail', label: 'nope' })).toBeUndefined();
});

test('an unexpired stored token serves without touching the token endpoint', async () => {
  const plane = openPlane(await tempDir());
  const tokens = await startTokenServer();
  const connectionId = configureOauth(plane, tokens.url);
  storeTokens(plane, connectionId, {
    access_token: 'ya29.long-lived',
    refresh_token: '1//r1',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  const broker = new ConnectionBroker(() => plane);
  const auth = await broker.resolveForFire({ kind: 'pull.gmail', label: 'personal' });
  expect(auth && 'values' in auth ? auth.values : undefined).toEqual({
    access_token: 'ya29.long-lived',
  });
  expect(tokens.requests).toHaveLength(0);
});

test('an expired token refreshes; a ROTATED refresh token persists before the new access token is used', async () => {
  const plane = openPlane(await tempDir());
  const tokens = await startTokenServer();
  const connectionId = configureOauth(plane, tokens.url);
  storeTokens(plane, connectionId, {
    access_token: 'ya29.stale',
    refresh_token: '1//original',
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  tokens.respond({
    access_token: 'ya29.fresh',
    refresh_token: '1//rotated',
    expires_in: 3600,
    token_type: 'Bearer',
  });
  const broker = new ConnectionBroker(() => plane);
  const auth = await broker.resolveForFire({ kind: 'pull.gmail', label: 'personal' });
  expect(auth && 'values' in auth ? auth.values : undefined).toEqual({
    access_token: 'ya29.fresh',
  });
  // The refresh grant carried the original token + the client pair.
  expect(tokens.requests).toHaveLength(1);
  expect(tokens.requests[0]).toMatchObject({
    grant_type: 'refresh_token',
    refresh_token: '1//original',
    client_id: 'cid.apps.googleusercontent.com',
    client_secret: 'GOCSPX-broker-test',
  });
  // The rotated pair is on the row, sealed, with a fresh expiry.
  const row = connectionRow(plane, connectionId);
  expect(String(row.access_token)).toMatch(/^sealed:v1:/);
  expect(String(row.refresh_token)).toMatch(/^sealed:v1:/);
  expect(row.status).toBe('active');
  // A follow-up resolve uses the persisted rotated pair without refreshing.
  const again = await broker.resolveForFire({ kind: 'pull.gmail', label: 'personal' });
  expect(again && 'values' in again ? again.values : undefined).toEqual({
    access_token: 'ya29.fresh',
  });
  expect(tokens.requests).toHaveLength(1);
});

test('concurrent fires produce ONE refresh (single-flight, no rotation race)', async () => {
  const plane = openPlane(await tempDir());
  const tokens = await startTokenServer();
  const connectionId = configureOauth(plane, tokens.url);
  storeTokens(plane, connectionId, {
    access_token: 'ya29.stale',
    refresh_token: '1//original',
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  tokens.respond({ access_token: 'ya29.single', refresh_token: '1//rotated', expires_in: 3600 });
  const broker = new ConnectionBroker(() => plane);
  const [a, b, c] = await Promise.all([
    broker.resolveForFire({ kind: 'pull.gmail', label: 'personal' }),
    broker.resolveForFire({ kind: 'pull.gmail', label: 'personal' }),
    broker.resolveForFire({ kind: 'pull.gmail', label: 'personal' }),
  ]);
  expect(tokens.requests).toHaveLength(1);
  for (const auth of [a, b, c]) {
    expect(auth && 'values' in auth ? auth.values : undefined).toEqual({
      access_token: 'ya29.single',
    });
  }
});

test('invalid_grant flips needs-auth with an owner-readable note; the fire is refused', async () => {
  const plane = openPlane(await tempDir());
  const tokens = await startTokenServer();
  const connectionId = configureOauth(plane, tokens.url);
  storeTokens(plane, connectionId, {
    access_token: 'ya29.stale',
    refresh_token: '1//revoked',
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  tokens.respond({ status: 400, body: { error: 'invalid_grant' } });
  const broker = new ConnectionBroker(() => plane);
  const auth = await broker.resolveForFire({ kind: 'pull.gmail', label: 'personal' });
  expect(auth && 'refused' in auth ? auth.refused : undefined).toMatch(/invalid_grant/);
  const row = connectionRow(plane, connectionId);
  expect(row.status).toBe('needs-auth');
  expect(String(row.auth_note)).toMatch(/reconnect/);
});

test('a 5xx token endpoint is transient: the fire skips but the connection does NOT flip', async () => {
  const plane = openPlane(await tempDir());
  const tokens = await startTokenServer();
  const connectionId = configureOauth(plane, tokens.url);
  storeTokens(plane, connectionId, {
    access_token: 'ya29.stale',
    refresh_token: '1//fine',
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  tokens.respond({ status: 500, body: { error: 'hiccup' } });
  tokens.respond({ status: 500, body: { error: 'hiccup' } });
  const broker = new ConnectionBroker(() => plane);
  const auth = await broker.resolveForFire({ kind: 'pull.gmail', label: 'personal' });
  expect(auth && 'refused' in auth ? auth.refused : undefined).toMatch(/transient/);
  // Retried once, then gave up for this fire — status untouched.
  expect(tokens.requests).toHaveLength(2);
  expect(connectionRow(plane, connectionId).status).toBe('active');
});

test('a hung token endpoint times out; treated as transient (retried, no flip) — issue #351', async () => {
  const plane = openPlane(await tempDir());
  const hung = await startHangingTokenServer();
  const connectionId = configureOauth(plane, hung.url);
  storeTokens(plane, connectionId, {
    access_token: 'ya29.stale',
    refresh_token: '1//fine',
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  // A short token timeout so the test doesn't wait out the real 30s default.
  const broker = new ConnectionBroker(() => plane, 30);
  const auth = await broker.resolveForFire({ kind: 'pull.gmail', label: 'personal' });
  expect(auth && 'refused' in auth ? auth.refused : undefined).toMatch(/transient/);
  // Same outcome as the 5xx-transient case: no flip, connection stays active.
  expect(connectionRow(plane, connectionId).status).toBe('active');
}, 10_000);

test('force refresh (the 401 lane) refreshes even an unexpired token', async () => {
  const plane = openPlane(await tempDir());
  const tokens = await startTokenServer();
  const connectionId = configureOauth(plane, tokens.url);
  storeTokens(plane, connectionId, {
    access_token: 'ya29.rejected-upstream',
    refresh_token: '1//r',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  tokens.respond({ access_token: 'ya29.after-force', expires_in: 3600 });
  const broker = new ConnectionBroker(() => plane);
  const auth = await broker.resolveForFire({ kind: 'pull.gmail', label: 'personal' });
  if (!auth || !('refresh' in auth) || !auth.refresh) throw new Error('expected a refresh hook');
  expect(await auth.refresh()).toEqual({ access_token: 'ya29.after-force' });
  expect(tokens.requests).toHaveLength(1);
});
