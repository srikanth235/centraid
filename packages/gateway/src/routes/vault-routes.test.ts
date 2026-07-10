// The outbox edit-before-send route slice (issue #308 A5 UI slice):
// approve-with-edit rebuilds the gmail.send wire request server-side from
// the edited artifact, an unsupported verb 4xx's instead of silently
// dropping the edit, shape-drifted artifacts are refused, and a
// client-supplied raw "request" is refused outright (the owner surface
// never handles the wire request — see `outbox-edit.ts`).

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { openVaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { makeVaultRouteHandler } from './vault-routes.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `vault-routes-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

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

function configureConnection(plane: VaultPlane): void {
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'sync.configure_credential',
    input: {
      kind: 'pull.gmail',
      label: 'personal',
      cred_kind: 'api_key',
      api_key: 'sk-route-test-key',
      allowed_hosts: ['gmail.googleapis.com'],
    },
  });
  if (outcome.status !== 'executed') {
    throw new Error(`configure failed: ${JSON.stringify(outcome)}`);
  }
}

function stageGmailSend(plane: VaultPlane, over: Record<string, unknown> = {}): string {
  const outcome = plane.gateway.invoke(plane.ownerCredential, {
    command: 'outbox.stage',
    input: {
      kind: 'pull.gmail',
      label: 'personal',
      verb: 'gmail.send',
      target: 'ravi@example.com',
      artifact: {
        to: ['ravi@example.com'],
        subject: 'Original subject',
        body: 'Original body.',
        message_id: 'msg-1',
      },
      request: {
        method: 'POST',
        url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        headers: {
          authorization: 'Bearer {{connection:access_token}}',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ raw: 'original-raw-placeholder' }),
      },
      ...over,
    },
  });
  if (outcome.status !== 'executed') throw new Error(`stage failed: ${JSON.stringify(outcome)}`);
  return (outcome as { output: { item_id: string } }).output.item_id;
}

function stageUnknownVerb(plane: VaultPlane): string {
  return stageGmailSend(plane, {
    verb: 'gcal.create_event',
    target: 'cal-1',
    artifact: { title: 'Standup', when: '2026-07-11T10:00:00Z' },
    request: {
      method: 'POST',
      url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      headers: { authorization: 'Bearer {{connection:access_token}}' },
      body: JSON.stringify({ title: 'Standup' }),
    },
  });
}

function rawOf(plane: VaultPlane, itemId: string): { requestBody: string; status: string } {
  const row = plane.db.vault
    .prepare('SELECT request_json, status FROM outbox_item WHERE item_id = ?')
    .get(itemId) as { request_json: string; status: string };
  return { requestBody: row.request_json, status: row.status };
}

async function setup(): Promise<{ base: string; plane: VaultPlane }> {
  const dir = await tempDir();
  const registry = openVaultRegistry({ rootDir: dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => registry.stop());
  const plane = registry.current();
  configureConnection(plane);
  const base = await startHandlerServer(makeVaultRouteHandler(registry));
  return { base, plane };
}

test('GET /outbox and GET /blocking surface canEdit true for gmail.send, false for an unregistered verb', async () => {
  const { base, plane } = await setup();
  const gmailItem = stageGmailSend(plane);
  const otherItem = stageUnknownVerb(plane);

  const listed = (await (await fetch(`${base}/centraid/_vault/outbox`)).json()) as {
    items: Array<{ itemId: string; canEdit: boolean }>;
  };
  const byId = new Map(listed.items.map((i) => [i.itemId, i.canEdit]));
  expect(byId.get(gmailItem)).toBe(true);
  expect(byId.get(otherItem)).toBe(false);

  const blocking = (await (await fetch(`${base}/centraid/_vault/blocking`)).json()) as {
    outbox: Array<{ itemId: string; canEdit: boolean }>;
  };
  const blockingById = new Map(blocking.outbox.map((i) => [i.itemId, i.canEdit]));
  expect(blockingById.get(gmailItem)).toBe(true);
  expect(blockingById.get(otherItem)).toBe(false);

  // The raw request never rides either read surface.
  expect(JSON.stringify(listed)).not.toContain('request_json');
  expect(JSON.stringify(listed)).not.toContain('{{connection:access_token}}');
});

test('approve-with-edit rebuilds the gmail.send request server-side from the edited artifact', async () => {
  const { base, plane } = await setup();
  const itemId = stageGmailSend(plane);

  const res = await fetch(`${base}/centraid/_vault/outbox/${itemId}`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approve',
      artifact: {
        to: ['ravi@example.com', 'asha@example.com'],
        subject: 'Edited subject',
        body: 'Edited body text.',
        message_id: 'msg-1',
      },
    }),
  });
  expect(res.status).toBe(200);
  const outcome = (await res.json()) as { status: string };
  expect(outcome.status).toBe('executed');

  const { requestBody, status } = rawOf(plane, itemId);
  expect(status).toBe('approved');
  const parsed = JSON.parse(requestBody) as {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  // Everything not derived from the artifact stayed as staged.
  expect(parsed.method).toBe('POST');
  expect(parsed.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  expect(parsed.headers.authorization).toBe('Bearer {{connection:access_token}}');
  // The raw RFC 2822 message reflects the EDITED subject/body/recipients.
  const raw = (JSON.parse(parsed.body) as { raw: string }).raw;
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  expect(decoded).toContain('To: ravi@example.com, asha@example.com');
  expect(decoded).toContain('Subject: Edited subject');
  expect(decoded).toContain('Edited body text.');
});

test('an unknown verb refuses the edit with a clear 4xx instead of silently keeping the staged request', async () => {
  const { base, plane } = await setup();
  const itemId = stageUnknownVerb(plane);

  const res = await fetch(`${base}/centraid/_vault/outbox/${itemId}`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approve',
      artifact: { title: 'Edited standup', when: '2026-07-11T11:00:00Z' },
    }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; message: string };
  expect(body.error).toBe('edit_unsupported');
  expect(body.message).toMatch(/editing isn't supported for gcal\.create_event/);

  // Nothing changed — the item is still pending, request untouched.
  const { status } = rawOf(plane, itemId);
  expect(status).toBe('pending');
});

test('shape-drifted artifacts (added field, removed field, type change) are all refused with a 400', async () => {
  const { base, plane } = await setup();

  const addedFieldItem = stageGmailSend(plane);
  const added = await fetch(`${base}/centraid/_vault/outbox/${addedFieldItem}`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approve',
      artifact: {
        to: ['ravi@example.com'],
        subject: 'Hi',
        body: 'x',
        message_id: 'msg-1',
        extra: 'not allowed',
      },
    }),
  });
  expect(added.status).toBe(400);
  expect((await added.json()).message).toMatch(/exactly the staged fields/);

  const removedFieldItem = stageGmailSend(plane);
  const removed = await fetch(`${base}/centraid/_vault/outbox/${removedFieldItem}`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approve',
      artifact: { to: ['ravi@example.com'], subject: 'Hi', body: 'x' },
    }),
  });
  expect(removed.status).toBe(400);
  expect((await removed.json()).message).toMatch(/exactly the staged fields/);

  const typeChangedItem = stageGmailSend(plane);
  const typeChanged = await fetch(`${base}/centraid/_vault/outbox/${typeChangedItem}`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approve',
      artifact: { to: ['ravi@example.com'], subject: 42, body: 'x', message_id: 'msg-1' },
    }),
  });
  expect(typeChanged.status).toBe(400);
  expect((await typeChanged.json()).message).toMatch(/must stay a string/);

  // None of the refused edits touched the staged rows.
  for (const id of [addedFieldItem, removedFieldItem, typeChangedItem]) {
    expect(rawOf(plane, id).status).toBe('pending');
  }
});

test('a client-supplied raw "request" is refused, not silently accepted or ignored', async () => {
  const { base, plane } = await setup();
  const itemId = stageGmailSend(plane);

  const res = await fetch(`${base}/centraid/_vault/outbox/${itemId}`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approve',
      request: { method: 'POST', url: 'https://evil.example.com/exfiltrate' },
    }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { message: string };
  expect(body.message).toMatch(/never accepts a raw "request"/);

  // The staged request is untouched — no path let a raw request through.
  const { requestBody, status } = rawOf(plane, itemId);
  expect(status).toBe('pending');
  expect(requestBody).not.toContain('evil.example.com');
});

test('an artifact edit on discard is refused — discarding sends nothing, so nothing to edit', async () => {
  const { base, plane } = await setup();
  const itemId = stageGmailSend(plane);

  const res = await fetch(`${base}/centraid/_vault/outbox/${itemId}`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'discard',
      artifact: { to: ['ravi@example.com'], subject: 'Hi', body: 'x', message_id: 'msg-1' },
    }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).message).toMatch(/only applies to "approve"/);
  expect(rawOf(plane, itemId).status).toBe('pending');
});

test('a plain approve with no artifact still works exactly as before (no edit path engaged)', async () => {
  const { base, plane } = await setup();
  const itemId = stageGmailSend(plane);

  const res = await fetch(`${base}/centraid/_vault/outbox/${itemId}`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approve' }),
  });
  expect(res.status).toBe(200);
  const { requestBody, status } = rawOf(plane, itemId);
  expect(status).toBe('approved');
  expect(requestBody).toContain('original-raw-placeholder');
});

test('unknown outbox item id on an edit attempt 404s', async () => {
  const { base } = await setup();
  const res = await fetch(`${base}/centraid/_vault/outbox/does-not-exist`, {
    method: 'POST',
    body: JSON.stringify({
      decision: 'approve',
      artifact: { to: ['x@example.com'], subject: 'Hi', body: 'x' },
    }),
  });
  expect(res.status).toBe(404);
});
