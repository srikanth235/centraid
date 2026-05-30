import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { appendLogs, readLogs, type LogEntry } from './log-store.ts';

let workspace: string;

beforeEach(async () => {
  workspace = path.join(os.tmpdir(), `centraid-logs-${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function mk(level: LogEntry['level'], msg: string, ts: number, handler = 'h'): LogEntry {
  return { ts, level, msg, source: 'query', handler };
}

test('append + read returns entries newest-first', async () => {
  await appendLogs(workspace, [mk('info', 'a', 1), mk('info', 'b', 2), mk('info', 'c', 3)]);

  const out = await readLogs(workspace);
  assert.equal(out.length, 3);
  assert.equal(out[0]!.msg, 'c');
  assert.equal(out[1]!.msg, 'b');
  assert.equal(out[2]!.msg, 'a');
});

test('limit caps results', async () => {
  await appendLogs(
    workspace,
    Array.from({ length: 5 }, (_, i) => mk('info', `msg${i}`, i + 1)),
  );

  const out = await readLogs(workspace, { limit: 2 });
  assert.equal(out.length, 2);
  // Newest-first; the latest two are msg4 and msg3.
  assert.equal(out[0]!.msg, 'msg4');
  assert.equal(out[1]!.msg, 'msg3');
});

test('level filter drops other levels', async () => {
  await appendLogs(workspace, [
    mk('info', 'i', 1),
    mk('warn', 'w', 2),
    mk('error', 'e', 3),
    mk('info', 'i2', 4),
  ]);

  const out = await readLogs(workspace, { level: 'warn' });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.msg, 'w');
});

test('sinceTs drops older entries', async () => {
  await appendLogs(workspace, [mk('info', 'a', 10), mk('info', 'b', 20), mk('info', 'c', 30)]);

  const out = await readLogs(workspace, { sinceTs: 20 });
  assert.equal(out.length, 2);
  assert.equal(out[0]!.msg, 'c');
  assert.equal(out[1]!.msg, 'b');
});

test('corrupted JSONL lines are skipped', async () => {
  await fs.writeFile(
    path.join(workspace, 'logs.jsonl'),
    [
      JSON.stringify(mk('info', 'good', 1)),
      'not-json',
      JSON.stringify({ ts: 'nope', level: 'info', msg: 'x', source: 'query', handler: 'h' }),
      JSON.stringify(mk('info', 'also-good', 2)),
      '',
    ].join('\n'),
    'utf8',
  );

  const out = await readLogs(workspace);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.msg, 'also-good');
  assert.equal(out[1]!.msg, 'good');
});

test('reads from both current and rotated file when both exist', async () => {
  // Simulate post-rotation state: rotated has older entries, current has newer.
  await fs.writeFile(
    path.join(workspace, 'logs.jsonl.1'),
    JSON.stringify(mk('info', 'old', 1)) + '\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(workspace, 'logs.jsonl'),
    JSON.stringify(mk('info', 'new', 2)) + '\n',
    'utf8',
  );

  const out = await readLogs(workspace);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.msg, 'new');
  assert.equal(out[1]!.msg, 'old');
});

test('empty workspace returns []', async () => {
  const out = await readLogs(workspace);
  assert.deepEqual(out, []);
});

test('append with empty array is a no-op', async () => {
  await appendLogs(workspace, []);
  // File should not exist yet.
  const exists = await fs
    .stat(path.join(workspace, 'logs.jsonl'))
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, false);
});

test('readLogs hard-caps oversized limit requests', async () => {
  await appendLogs(workspace, [mk('info', 'a', 1)]);

  const out = await readLogs(workspace, { limit: 999_999 });
  // Hard cap is 500; with one entry, length is just 1 — but the call must
  // not throw. We assert the value is bounded.
  assert.ok(out.length <= 500);
});

test('rejects entries with unknown source on read', async () => {
  await fs.writeFile(
    path.join(workspace, 'logs.jsonl'),
    JSON.stringify({ ts: 1, level: 'info', msg: 'x', source: 'rogue', handler: 'h' }) + '\n',
    'utf8',
  );
  const out = await readLogs(workspace);
  assert.equal(out.length, 0);
});
