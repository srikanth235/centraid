import { tempDir } from '@centraid/test-kit/temp-dir';
// The consent ceremony over HTTP (issue #304 phase 2): configure a BYO
// oauth2 credential, start the PKCE authorize, land the provider's redirect
// on the (bearer-free) callback, and watch the connection flip to active
// with sealed tokens — plus the health list never leaking a secret cell.

import { afterEach, expect, test } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import { openVaultRegistry } from '../serve/vault-registry.js';
import { ConnectionBroker } from '../serve/connection-broker.js';
import { makeConnectionsRouteHandler } from './connections-routes.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
async function startHandlerServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>,
): Promise<string> {
  const server = http.createServer((req, res) => {
    void handler(req, res).then((owned) => {
      if (!owned) {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

/** A scriptable provider token endpoint recording each form POST. */
async function startTokenServer(): Promise<{
  url: string;
  requests: Array<Record<string, string>>;
  respond: (status: number, body: Record<string, unknown>) => void;
}> {
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
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}/token`,
    requests,
    respond: (status, body) => responses.push({ status, body }),
  };
}

test('the whole ceremony: configure → authorize → callback → active with sealed tokens', async () => {
  const dir = await tempDir();
  const registry = openVaultRegistry({ rootDir: dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => registry.stop());
  const broker = new ConnectionBroker(() => registry.current());
  const base = await startHandlerServer(makeConnectionsRouteHandler(registry, broker));
  const tokens = await startTokenServer();

  // 1. Configure the BYO client.
  const configured = (await (
    await fetch(`${base}/centraid/_vault/connections`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'pull.gmail',
        label: 'personal',
        cred_kind: 'oauth2',
        provider: 'google',
        auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_url: tokens.url,
        scopes: 'https://www.googleapis.com/auth/gmail.readonly',
        client_id: 'cid.apps.googleusercontent.com',
        client_secret: 'GOCSPX-route-test',
        allowed_hosts: ['gmail.googleapis.com'],
      }),
    })
  ).json()) as Record<string, unknown>;
  expect(configured).toMatchObject({ ok: true, status: 'needs-auth' });
  const connectionId = configured.connection_id as string;

  // 2. The health list shows the pending state and NEVER a secret cell.
  const listing = (await (await fetch(`${base}/centraid/_vault/connections`)).json()) as {
    connections: Array<Record<string, unknown>>;
  };
  expect(listing.connections).toHaveLength(1);
  expect(listing.connections[0]).toMatchObject({
    kind: 'pull.gmail',
    status: 'needs-auth',
    cred_kind: 'oauth2',
    auth_note: expect.stringContaining('authorization pending'),
    has_refresh_token: false,
    allowed_hosts: ['gmail.googleapis.com'],
  });
  expect(JSON.stringify(listing)).not.toContain('GOCSPX');
  expect(JSON.stringify(listing)).not.toContain('sealed:v1:');

  // 3. Start the authorize — PKCE parameters on the consent URL.
  const authorize = (await (
    await fetch(`${base}/centraid/_vault/connections/${connectionId}/authorize`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
  ).json()) as Record<string, unknown>;
  const authUrl = new URL(authorize.auth_url as string);
  expect(authUrl.origin + authUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(authUrl.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com');
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
  expect(authUrl.searchParams.get('access_type')).toBe('offline');
  const state = authUrl.searchParams.get('state')!;
  expect(authorize.redirect_uri).toContain('/centraid/_vault/oauth/callback');

  // 4. The provider bounces the browser back with code + state.
  tokens.respond(200, {
    access_token: 'ya29.ceremony',
    refresh_token: '1//ceremony',
    expires_in: 3600,
    token_type: 'Bearer',
  });
  const callback = await fetch(
    `${base}/centraid/_vault/oauth/callback?state=${state}&code=auth-code-1`,
  );
  expect(callback.status).toBe(200);
  expect(await callback.text()).toContain('Connected');

  // The code exchange carried PKCE verifier + the client pair.
  expect(tokens.requests).toHaveLength(1);
  expect(tokens.requests[0]).toMatchObject({
    grant_type: 'authorization_code',
    code: 'auth-code-1',
    client_id: 'cid.apps.googleusercontent.com',
    client_secret: 'GOCSPX-route-test',
  });
  const verifier = tokens.requests[0]!.code_verifier!;
  expect(crypto.createHash('sha256').update(verifier).digest('base64url')).toBe(
    authUrl.searchParams.get('code_challenge'),
  );

  // 5. The connection is live, tokens sealed on the sidecar.
  const after = (await (await fetch(`${base}/centraid/_vault/connections`)).json()) as {
    connections: Array<Record<string, unknown>>;
  };
  expect(after.connections[0]).toMatchObject({
    status: 'active',
    auth_note: null,
    has_refresh_token: true,
  });
  const plane = registry.current();
  const cred = plane.db.vault
    .prepare('SELECT access_token, refresh_token FROM sync_connection_credential')
    .get() as { access_token: string; refresh_token: string };
  expect(cred.access_token).toMatch(/^sealed:v1:/);
  expect(cred.refresh_token).toMatch(/^sealed:v1:/);

  // 6. The state is single-use — a replayed callback fails loudly.
  const replay = await fetch(
    `${base}/centraid/_vault/oauth/callback?state=${state}&code=auth-code-1`,
  );
  expect(replay.status).toBe(400);
  expect(await replay.text()).toContain('unknown or expired');
});

test('a declined consent screen lands a readable page and consumes the state', async () => {
  const dir = await tempDir();
  const registry = openVaultRegistry({ rootDir: dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => registry.stop());
  const broker = new ConnectionBroker(() => registry.current());
  const base = await startHandlerServer(makeConnectionsRouteHandler(registry, broker));
  const tokens = await startTokenServer();

  const configured = (await (
    await fetch(`${base}/centraid/_vault/connections`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'pull.gcal',
        label: 'personal',
        cred_kind: 'oauth2',
        auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_url: tokens.url,
        client_id: 'cid',
        allowed_hosts: ['www.googleapis.com'],
      }),
    })
  ).json()) as Record<string, unknown>;
  const authorize = (await (
    await fetch(`${base}/centraid/_vault/connections/${configured.connection_id}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ redirect_uri: 'http://127.0.0.1:9/cb' }),
    })
  ).json()) as Record<string, unknown>;
  const state = new URL(authorize.auth_url as string).searchParams.get('state')!;
  const denied = await fetch(
    `${base}/centraid/_vault/oauth/callback?state=${state}&error=access_denied`,
  );
  expect(denied.status).toBe(400);
  expect(await denied.text()).toContain('declined');
  // The state died with the denial.
  const replay = await fetch(`${base}/centraid/_vault/oauth/callback?state=${state}&code=x`);
  expect(await replay.text()).toContain('unknown or expired');
});

test('pause and resume ride PATCH; providers expose the BYO wizard with the Google traps', async () => {
  const dir = await tempDir();
  const registry = openVaultRegistry({ rootDir: dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => registry.stop());
  const broker = new ConnectionBroker(() => registry.current());
  const base = await startHandlerServer(makeConnectionsRouteHandler(registry, broker));

  const configured = (await (
    await fetch(`${base}/centraid/_vault/connections`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'pull.github',
        label: 'personal',
        cred_kind: 'api_key',
        api_key: 'ghp_x',
        allowed_hosts: ['api.github.com'],
      }),
    })
  ).json()) as Record<string, unknown>;
  const paused = (await (
    await fetch(`${base}/centraid/_vault/connections/${configured.connection_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paused' }),
    })
  ).json()) as Record<string, unknown>;
  expect(paused).toMatchObject({ ok: true, status: 'paused' });

  const providers = (await (
    await fetch(`${base}/centraid/_vault/connections/providers`)
  ).json()) as Record<string, unknown>;
  const google = (providers.providers as { id: string; setup: string[] }[]).find(
    (p) => p.id === 'google',
  )!;
  // The two known traps are IN the wizard, not tribal knowledge.
  expect(google.setup.join('\n')).toMatch(/In production.*not Testing|Testing status/);
  expect(google.setup.join('\n')).toMatch(/Photos/);
  const github = (providers.providers as { id: string; credKind: string }[]).find(
    (p) => p.id === 'github',
  )!;
  expect(github.credKind).toBe('api_key');
  const ids = (providers.providers as { id: string }[]).map((p) => p.id);
  // Wave-2 personal-vault catalog (Microsoft parity + eng/notes/tasks/chat/files).
  for (const id of ['microsoft', 'gitlab', 'linear', 'notion', 'todoist', 'slack', 'dropbox']) {
    expect(ids).toContain(id);
  }
});

test('DELETE removes a connection with no history, 409s on a real refusal, 404s an unknown id', async () => {
  const dir = await tempDir();
  const registry = openVaultRegistry({ rootDir: dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => registry.stop());
  const broker = new ConnectionBroker(() => registry.current());
  const base = await startHandlerServer(makeConnectionsRouteHandler(registry, broker));

  const configured = (await (
    await fetch(`${base}/centraid/_vault/connections`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'pull.github',
        label: 'personal',
        cred_kind: 'api_key',
        api_key: 'ghp_x',
        allowed_hosts: ['api.github.com'],
      }),
    })
  ).json()) as Record<string, unknown>;
  const connectionId = configured.connection_id as string;

  // Unknown id: 404, not a 400/409 (the command never even runs).
  const unknown = await fetch(`${base}/centraid/_vault/connections/no-such-connection`, {
    method: 'DELETE',
  });
  expect(unknown.status).toBe(404);

  // A real refusal (undecided outbox history) maps to 409 with the reason.
  const plane = registry.current();
  const now = new Date().toISOString();
  plane.db.vault
    .prepare(
      `INSERT INTO outbox_item
         (item_id, connection_id, actor_id, actor_kind, verb, target, artifact_json,
          request_json, status, staged_at)
       VALUES ('item-1', ?, 'owner-1', 'owner', 'gmail.send', 'someone@example.com', '{}',
               '{"method":"POST","url":"https://x"}', 'pending', ?)`,
    )
    .run(connectionId, now);
  const blocked = await fetch(`${base}/centraid/_vault/connections/${connectionId}`, {
    method: 'DELETE',
  });
  expect(blocked.status).toBe(409);
  const blockedBody = (await blocked.json()) as { ok: boolean; error: string };
  expect(blockedBody.ok).toBe(false);
  expect(blockedBody.error).toMatch(/awaiting a decision/);
  // Nothing moved — the connection survives the refusal.
  const stillListed = (await (await fetch(`${base}/centraid/_vault/connections`)).json()) as {
    connections: unknown[];
  };
  expect(stillListed.connections).toHaveLength(1);

  // Clear the block, then the real delete succeeds.
  plane.db.vault.prepare(`DELETE FROM outbox_item WHERE item_id = 'item-1'`).run();
  const removed = await fetch(`${base}/centraid/_vault/connections/${connectionId}`, {
    method: 'DELETE',
  });
  expect(removed.status).toBe(200);
  const removedBody = (await removed.json()) as Record<string, unknown>;
  expect(removedBody).toMatchObject({ ok: true, connection_id: connectionId });
  const after = (await (await fetch(`${base}/centraid/_vault/connections`)).json()) as {
    connections: unknown[];
  };
  expect(after.connections).toHaveLength(0);
});
