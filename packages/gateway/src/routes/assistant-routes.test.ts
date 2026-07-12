/*
 * The vault assistant's shell-level surface: `_turn` drives the runner over
 * SSE with the assistant preamble (register + live vault map) and records
 * the turn under the reserved `_assistant` ledger scope; `resolve` turns
 * answer refs into owner-resolved cards. The registry is duck-typed — the
 * routes only touch current()/currentWorkspace() — and the runner is a stub,
 * so the tests stay hermetic.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import {
  ASSISTANT_APP_ID,
  ConversationHistoryStore,
  openJournalDb,
  type ConversationRunner,
  type VaultWorkspace,
} from '@centraid/app-engine';
import type { DatabaseSync } from 'node:sqlite';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { makeAssistantRouteHandler, type AssistantRouteOptions } from './assistant-routes.js';

let dir: string;
let journal: DatabaseSync | undefined;
let server: Server | undefined;
let store: ConversationHistoryStore;

function fakeRegistry(): VaultRegistry {
  const workspace: VaultWorkspace = {
    vaultId: 'v-test',
    ownerPartyId: 'owner-party',
    appsDir: path.join(dir, 'apps'),
    journal: () => {
      journal ??= openJournalDb(path.join(dir, 'journal.db'));
      return journal;
    },
    journalDbFile: path.join(dir, 'journal.db'),
    runnerSessionDir: path.join(dir, 'runner-sessions'),
  };
  const plane = {
    name: 'Family',
    boot: { vaultId: 'v-test' },
    assistantContext: () => 'SCHEMA-DOC-MARKER',
    resolveAsOwner: (refs: { type: string; id: string }[]) => ({
      cards: refs.map((r) => ({
        type: r.type,
        id: r.id,
        status: 'live',
        title: `card:${r.id}`,
        subtitle: null,
        thumbnail_content_id: null,
      })),
      receiptId: 'receipt-1',
    }),
  };
  return {
    current: () => plane,
    currentWorkspace: () => workspace,
  } as unknown as VaultRegistry;
}

async function bootstrap(
  runner: ConversationRunner,
  extra?: Partial<AssistantRouteOptions>,
): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), `assistant-routes-${crypto.randomUUID()}-`));
  const registry = fakeRegistry();
  store = new ConversationHistoryStore(() => registry.currentWorkspace());
  const handler = makeAssistantRouteHandler({
    vaults: registry,
    conversationStore: store,
    runner,
    conversationLocks: new Map(),
    ...extra,
  });
  server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('unhandled');
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  journal?.close();
  journal = undefined;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('_turn streams the runner and records under the _assistant scope', async () => {
  let seenPrompt = '';
  let seenAppId = '';
  const runner: ConversationRunner = {
    async run(input) {
      seenPrompt = input.extraSystemPrompt;
      seenAppId = input.appId;
      input.onEvent({ type: 'assistant.start' });
      input.onEvent({
        type: 'tool.start',
        toolCallId: 't1',
        toolName: 'vault_sql',
        sql: 'SELECT 1',
      });
      input.onEvent({ type: 'tool.result', toolCallId: 't1', toolName: 'vault_sql', ok: true });
      input.onEvent({ type: 'assistant.delta', delta: 'One.' });
      input.onEvent({ type: 'final', text: 'One.' });
    },
  };
  const base = await bootstrap(runner);
  const session = store.createSession(ASSISTANT_APP_ID);

  const res = await fetch(`${base}/centraid/_vault/assistant/_turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: session.id, message: 'how many?' }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type') ?? '').toMatch(/text\/event-stream/);
  const text = await res.text();
  expect(text).toMatch(/event: tool.start/);
  expect(text).toMatch(/"sql":"SELECT 1"/);
  expect(text).toMatch(/event: final/);
  expect(text).toMatch(/event: end/);

  // The preamble is the assistant register + the live vault map.
  expect(seenAppId).toBe(ASSISTANT_APP_ID);
  expect(seenPrompt).toContain('vault assistant');
  expect(seenPrompt).toContain('SCHEMA-DOC-MARKER');
  expect(seenPrompt).toContain('block:table');

  // The turn landed in the ledger: transcript + auto-title off turn one.
  const loaded = store.getSession(ASSISTANT_APP_ID, session.id);
  expect(loaded?.title).toBe('how many?');
  const kinds = loaded?.messages.map((m) => (m.payload as { kind: string }).kind);
  expect(kinds).toEqual(['user', 'tool', 'ai']);
});

test('_turn threads valid attachment refs to the runner as resolved blob paths and records them on the ledger', async () => {
  let seenAttachments: unknown;
  const runner: ConversationRunner = {
    async run(input) {
      seenAttachments = input.attachments;
      input.onEvent({ type: 'final', text: 'noted' });
    },
  };
  const base = await bootstrap(runner);
  const session = store.createSession(ASSISTANT_APP_ID);

  const hash = 'a'.repeat(64);
  const res = await fetch(`${base}/centraid/_vault/assistant/_turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId: session.id,
      message: 'see attached',
      attachments: [{ hash, mime: 'image/png', filename: 'shot.png', sizeBytes: 42 }],
    }),
  });
  expect(res.status).toBe(200);
  await res.text();

  const resolved = seenAttachments as Array<{ path: string; mime: string; filename?: string }>;
  expect(resolved).toHaveLength(1);
  expect(resolved[0]!.path).toContain(hash);
  expect(resolved[0]!.mime).toBe('image/png');
  expect(resolved[0]!.filename).toBe('shot.png');

  const loaded = store.getSession(ASSISTANT_APP_ID, session.id);
  const user = loaded?.messages[0]!.payload as {
    kind: string;
    attachments?: Array<{ hash: string; mime: string; sizeBytes: number; filename?: string }>;
  };
  expect(user.attachments).toEqual([
    { hash, mime: 'image/png', sizeBytes: 42, filename: 'shot.png', url: expect.any(String) },
  ]);
});

test('_turn silently drops malformed attachment refs (bad hash / missing mime)', async () => {
  let seenAttachments: unknown = 'unset';
  const runner: ConversationRunner = {
    async run(input) {
      seenAttachments = input.attachments;
      input.onEvent({ type: 'final', text: 'noted' });
    },
  };
  const base = await bootstrap(runner);
  const session = store.createSession(ASSISTANT_APP_ID);

  const res = await fetch(`${base}/centraid/_vault/assistant/_turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId: session.id,
      message: 'bad attachments',
      attachments: [
        { hash: 'not-a-sha256', mime: 'image/png' }, // malformed hash
        { hash: 'b'.repeat(64) }, // missing mime
        'garbage', // not even an object
      ],
    }),
  });
  expect(res.status).toBe(200);
  await res.text();

  expect(seenAttachments).toBeUndefined();
  const loaded = store.getSession(ASSISTANT_APP_ID, session.id);
  const user = loaded?.messages[0]!.payload as Record<string, unknown>;
  expect('attachments' in user).toBe(false);
});

test('_turn resolves the model through resolveModel, passing the assistant subsystem + explicit body value', async () => {
  let seenModel: string | undefined;
  const runner: ConversationRunner = {
    async run(input) {
      seenModel = input.model;
      input.onEvent({ type: 'final', text: 'ok' });
    },
  };
  const calls: Array<{ subsystem: string; explicit?: string }> = [];
  const resolveModel = async (subsystem: string, explicit?: string): Promise<string | undefined> => {
    calls.push({ subsystem, explicit });
    return explicit ?? 'prefs-resolved-model';
  };
  const base = await bootstrap(runner, {
    resolveModel: resolveModel as AssistantRouteOptions['resolveModel'],
  });
  const session = store.createSession(ASSISTANT_APP_ID);

  // No explicit model in the body — falls through to the prefs resolution.
  let res = await fetch(`${base}/centraid/_vault/assistant/_turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: session.id, message: 'hi' }),
  });
  expect(res.status).toBe(200);
  await res.text();
  expect(calls[0]).toEqual({ subsystem: 'assistant', explicit: undefined });
  expect(seenModel).toBe('prefs-resolved-model');

  // An explicit body model rides through as resolveModel's `explicit` arg.
  const session2 = store.createSession(ASSISTANT_APP_ID);
  res = await fetch(`${base}/centraid/_vault/assistant/_turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: session2.id, message: 'hi again', model: 'opus' }),
  });
  expect(res.status).toBe(200);
  await res.text();
  expect(calls[1]).toEqual({ subsystem: 'assistant', explicit: 'opus' });
  expect(seenModel).toBe('opus');
});

test('_turn 404s on an unknown thread', async () => {
  const base = await bootstrap({ run: async () => undefined } as unknown as ConversationRunner);
  const res = await fetch(`${base}/centraid/_vault/assistant/_turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'nope', message: 'hi' }),
  });
  expect(res.status).toBe(404);
});

test('resolve returns owner-resolved cards for refs', async () => {
  const base = await bootstrap({ run: async () => undefined } as unknown as ConversationRunner);
  const res = await fetch(`${base}/centraid/_vault/assistant/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refs: [{ type: 'core.party', id: 'p1' }] }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { cards: Array<{ title: string }> };
  expect(body.cards[0]?.title).toBe('card:p1');
});

test('resolve refuses a bodyless/malformed request', async () => {
  const base = await bootstrap({ run: async () => undefined } as unknown as ConversationRunner);
  const res = await fetch(`${base}/centraid/_vault/assistant/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refs: 'nope' }),
  });
  expect(res.status).toBe(400);
});
