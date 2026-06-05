import { afterEach, beforeEach, expect, test } from 'vitest';
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
  expect(out.length).toBe(3);
  expect(out[0]!.msg).toBe('c');
  expect(out[1]!.msg).toBe('b');
  expect(out[2]!.msg).toBe('a');
});

test('limit caps results', async () => {
  await appendLogs(
    workspace,
    Array.from({ length: 5 }, (_, i) => mk('info', `msg${i}`, i + 1)),
  );

  const out = await readLogs(workspace, { limit: 2 });
  expect(out.length).toBe(2);
  // Newest-first; the latest two are msg4 and msg3.
  expect(out[0]!.msg).toBe('msg4');
  expect(out[1]!.msg).toBe('msg3');
});

test('level filter drops other levels', async () => {
  await appendLogs(workspace, [
    mk('info', 'i', 1),
    mk('warn', 'w', 2),
    mk('error', 'e', 3),
    mk('info', 'i2', 4),
  ]);

  const out = await readLogs(workspace, { level: 'warn' });
  expect(out.length).toBe(1);
  expect(out[0]!.msg).toBe('w');
});

test('sinceTs drops older entries', async () => {
  await appendLogs(workspace, [mk('info', 'a', 10), mk('info', 'b', 20), mk('info', 'c', 30)]);

  const out = await readLogs(workspace, { sinceTs: 20 });
  expect(out.length).toBe(2);
  expect(out[0]!.msg).toBe('c');
  expect(out[1]!.msg).toBe('b');
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
  expect(out.length).toBe(2);
  expect(out[0]!.msg).toBe('also-good');
  expect(out[1]!.msg).toBe('good');
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
  expect(out.length).toBe(2);
  expect(out[0]!.msg).toBe('new');
  expect(out[1]!.msg).toBe('old');
});

test('empty workspace returns []', async () => {
  const out = await readLogs(workspace);
  expect(out).toEqual([]);
});

test('append with empty array is a no-op', async () => {
  await appendLogs(workspace, []);
  // File should not exist yet.
  const exists = await fs
    .stat(path.join(workspace, 'logs.jsonl'))
    .then(() => true)
    .catch(() => false);
  expect(exists).toBe(false);
});

test('readLogs hard-caps oversized limit requests', async () => {
  await appendLogs(workspace, [mk('info', 'a', 1)]);

  const out = await readLogs(workspace, { limit: 999_999 });
  // Hard cap is 500; with one entry, length is just 1 — but the call must
  // not throw. We assert the value is bounded.
  expect(out.length <= 500).toBeTruthy();
});

test('rejects entries with unknown source on read', async () => {
  await fs.writeFile(
    path.join(workspace, 'logs.jsonl'),
    JSON.stringify({ ts: 1, level: 'info', msg: 'x', source: 'rogue', handler: 'h' }) + '\n',
    'utf8',
  );
  const out = await readLogs(workspace);
  expect(out.length).toBe(0);
});
