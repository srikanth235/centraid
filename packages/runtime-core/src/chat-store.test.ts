import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatStore, chatSessionFile, isValidWindowId } from './chat-store.js';

async function tmpAppDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-chat-store-'));
  return dir;
}

test('isValidWindowId rejects path-escape attempts and reserved names', () => {
  assert.equal(isValidWindowId('w1'), true);
  assert.equal(isValidWindowId('1'), true);
  assert.equal(isValidWindowId('a-b_c:d'), true);
  assert.equal(isValidWindowId(''), false);
  assert.equal(isValidWindowId('.hidden'), false);
  assert.equal(isValidWindowId('../escape'), false);
  assert.equal(isValidWindowId('with/slash'), false);
  assert.equal(isValidWindowId('index.json'), false);
  assert.equal(isValidWindowId('a'.repeat(200)), false);
});

test('upsertWindow returns existing meta when called twice', async () => {
  const dir = await tmpAppDir();
  const store = new ChatStore(dir);
  const a = await store.upsertWindow('1', 'full');
  const b = await store.upsertWindow('1', 'data'); // desired mode ignored after first
  assert.equal(a.id, b.id);
  assert.equal(b.mode, 'full');
});

test('upsertWindow swaps adapter session id when adapter kind changes mid-window', async () => {
  const dir = await tmpAppDir();
  const store = new ChatStore(dir);
  await store.upsertWindow('1', 'full', { kind: 'codex', sessionId: 'cx-1' });
  const next = await store.upsertWindow('1', 'full', { kind: 'claude-code', sessionId: 'cl-1' });
  assert.equal(next.adapterKind, 'claude-code');
  assert.equal(next.adapterSessionId, 'cl-1');
});

test('noteTurn bumps counters', async () => {
  const dir = await tmpAppDir();
  const store = new ChatStore(dir);
  await store.upsertWindow('1', 'full');
  await store.noteTurn('1');
  await store.noteTurn('1');
  const meta = await store.getWindow('1');
  assert.equal(meta?.turnCount, 2);
});

test('listWindows sorts by lastMessageAt desc', async () => {
  const dir = await tmpAppDir();
  const store = new ChatStore(dir);
  await store.upsertWindow('a', 'full');
  // tiny delay so timestamps differ
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.upsertWindow('b', 'full');
  const list = await store.listWindows();
  assert.equal(list[0]?.id, 'b');
  assert.equal(list[1]?.id, 'a');
});

test('deleteWindow removes from index and unlinks transcript file', async () => {
  const dir = await tmpAppDir();
  const store = new ChatStore(dir);
  await store.upsertWindow('1', 'full');
  const transcript = chatSessionFile(dir, '1');
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', text: 'hi' }) + '\n');
  const removed = await store.deleteWindow('1');
  assert.equal(removed, true);
  await assert.rejects(fs.access(transcript), /ENOENT/);
  const meta = await store.getWindow('1');
  assert.equal(meta, undefined);
});

test('readTranscript parses JSONL and skips blank lines', async () => {
  const dir = await tmpAppDir();
  const store = new ChatStore(dir);
  const file = chatSessionFile(dir, '1');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"a":1}\n\n{"b":2}\nnot-json\n{"c":3}\n');
  const entries = await store.readTranscript('1');
  assert.deepEqual(entries, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('readTranscript returns empty array when file missing', async () => {
  const dir = await tmpAppDir();
  const store = new ChatStore(dir);
  const entries = await store.readTranscript('1');
  assert.deepEqual(entries, []);
});
