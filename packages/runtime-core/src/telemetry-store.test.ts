import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { TelemetryStore } from './telemetry-store.ts';
import type { TelemetrySpanRecord } from './telemetry.ts';

let workspace: string;
let store: TelemetryStore;

function mkRecord(overrides: Partial<TelemetrySpanRecord> = {}): TelemetrySpanRecord {
  const ts = overrides.startedAt ?? 1_700_000_000_000;
  return {
    appId: 'app-a',
    traceId: 't'.repeat(32),
    spanId: 's'.repeat(16),
    kind: 'query',
    handler: 'h',
    startedAt: ts,
    durationMs: 5,
    status: 'ok',
    events: [{ ts, level: 'info', msg: 'hello' }],
    ...overrides,
  };
}

beforeEach(async () => {
  workspace = path.join(os.tmpdir(), `centraid-telemetry-${crypto.randomBytes(6).toString('hex')}`);
  await fs.mkdir(workspace, { recursive: true });
  store = new TelemetryStore(path.join(workspace, 'telemetry.sqlite'), {
    sweepIntervalMs: 0, // disable the background sweeper in tests
    maxRecordsPerSec: 0, // disable admission throttling unless a test opts in
  });
});

afterEach(async () => {
  store.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

test('records a span + its events in one transaction', async () => {
  const ts = Date.now();
  await store.recordHandler(
    mkRecord({
      startedAt: ts,
      events: [
        { ts, level: 'info', msg: 'a' },
        { ts: ts + 1, level: 'warn', msg: 'b' },
        { ts: ts + 2, level: 'error', msg: 'c' },
      ],
    }),
  );

  const all = await store.readEvents('app-a');
  assert.equal(all.length, 3);
  // Newest-first.
  assert.deepEqual(
    all.map((e) => e.msg),
    ['c', 'b', 'a'],
  );
  assert.equal(all[0]!.handler, 'h');
  assert.equal(all[0]!.source, 'query');
});

test('readEvents filters by level and sinceTs', async () => {
  const ts = Date.now();
  await store.recordHandler(
    mkRecord({
      startedAt: ts,
      events: [
        { ts, level: 'info', msg: 'old-info' },
        { ts: ts + 100, level: 'warn', msg: 'new-warn' },
        { ts: ts + 200, level: 'error', msg: 'new-error' },
      ],
    }),
  );

  const errs = await store.readEvents('app-a', { level: 'error' });
  assert.equal(errs.length, 1);
  assert.equal(errs[0]!.msg, 'new-error');

  const recent = await store.readEvents('app-a', { sinceTs: ts + 50 });
  assert.equal(recent.length, 2);
  assert.ok(recent.every((e) => e.ts >= ts + 50));
});

test('readEvents respects limit (capped at 500)', async () => {
  const ts = Date.now();
  const events = Array.from({ length: 50 }, (_, i) => ({
    ts: ts + i,
    level: 'info' as const,
    msg: `m${i}`,
  }));
  await store.recordHandler(mkRecord({ startedAt: ts, events }));

  const five = await store.readEvents('app-a', { limit: 5 });
  assert.equal(five.length, 5);
  // Limit > hard cap → still capped (here just verifies it returns ≤ stored).
  const huge = await store.readEvents('app-a', { limit: 100_000 });
  assert.equal(huge.length, 50);
});

test('deleteApp drops only that app rows', async () => {
  const ts = Date.now();
  await store.recordHandler(mkRecord({ appId: 'app-a', startedAt: ts }));
  await store.recordHandler(mkRecord({ appId: 'app-b', spanId: 'b'.repeat(16), startedAt: ts }));

  await store.deleteApp('app-a');
  const a = await store.readEvents('app-a');
  const b = await store.readEvents('app-b');
  assert.equal(a.length, 0);
  assert.equal(b.length, 1);
});

test('truncates oversize event messages', async () => {
  // 9 KiB msg should be truncated to ~8 KiB with a suffix.
  const big = 'x'.repeat(9 * 1024);
  const ts = Date.now();
  await store.recordHandler(mkRecord({ startedAt: ts, events: [{ ts, level: 'info', msg: big }] }));
  const [row] = await store.readEvents('app-a');
  assert.ok(row, 'expected one event row');
  assert.ok(row.msg.endsWith('…(truncated)'), 'expected truncation marker');
  assert.ok(Buffer.byteLength(row.msg, 'utf8') < big.length);
});

test('caps per-record event count and appends a truncation marker', async () => {
  const ts = Date.now();
  const tooMany = Array.from({ length: 600 }, (_, i) => ({
    ts: ts + i,
    level: 'info' as const,
    msg: `m${i}`,
  }));
  await store.recordHandler(mkRecord({ startedAt: ts, events: tooMany }));

  const rows = await store.readEvents('app-a', { limit: 500 });
  assert.equal(rows.length, 500, 'count cap should apply');
  // The synthesized marker is the latest event by ts.
  const marker = rows[0]!;
  assert.equal(marker.level, 'warn');
  assert.match(marker.msg, /events truncated/);
});

test('sweep deletes rows past expires_at and only those', async () => {
  // Insert with controlled clock so the row's expires_at is in the past
  // by the time we sweep. The store stamps expires_at = startedAt + TTL,
  // so picking startedAt = now - 31 days makes an OK-span past its 7-day TTL.
  const now = Date.now();
  const old = now - 31 * 24 * 60 * 60 * 1000;
  await store.recordHandler(
    mkRecord({
      startedAt: old,
      events: [{ ts: old, level: 'info', msg: 'stale' }],
    }),
  );
  await store.recordHandler(
    mkRecord({
      spanId: 'fresh'.padEnd(16, 'f'),
      startedAt: now,
      events: [{ ts: now, level: 'info', msg: 'fresh' }],
    }),
  );

  const before = await store.readEvents('app-a', { limit: 10 });
  assert.equal(before.length, 2);

  const result = store.sweep();
  assert.ok(result.events >= 1, 'should sweep at least the stale event');
  assert.ok(result.spans >= 1, 'should sweep at least the stale span');

  const after = await store.readEvents('app-a', { limit: 10 });
  assert.equal(after.length, 1);
  assert.equal(after[0]!.msg, 'fresh');
});

test('getAppSettings returns defaults for a fresh app', async () => {
  const s = await store.getAppSettings('app-a');
  assert.deepEqual(s, { enabled: true, minLevel: 'info' });
});

test('setAppSettings merges patch over current; missing keys keep prior values', async () => {
  await store.setAppSettings('app-a', { minLevel: 'warn' });
  let s = await store.getAppSettings('app-a');
  assert.equal(s.enabled, true);
  assert.equal(s.minLevel, 'warn');

  await store.setAppSettings('app-a', { enabled: false });
  s = await store.getAppSettings('app-a');
  assert.equal(s.enabled, false);
  // minLevel should be preserved from the previous patch.
  assert.equal(s.minLevel, 'warn');
});

test('disabled app drops both span and events', async () => {
  await store.setAppSettings('app-a', { enabled: false });
  const ts = Date.now();
  await store.recordHandler(
    mkRecord({
      startedAt: ts,
      events: [{ ts, level: 'error', msg: 'should-be-dropped' }],
    }),
  );
  const rows = await store.readEvents('app-a', { limit: 10 });
  assert.equal(rows.length, 0);
});

test('minLevel filters events below threshold before write', async () => {
  await store.setAppSettings('app-a', { minLevel: 'warn' });
  const ts = Date.now();
  await store.recordHandler(
    mkRecord({
      startedAt: ts,
      events: [
        { ts, level: 'info', msg: 'i' },
        { ts: ts + 1, level: 'warn', msg: 'w' },
        { ts: ts + 2, level: 'error', msg: 'e' },
      ],
    }),
  );
  const rows = await store.readEvents('app-a', { limit: 10 });
  assert.equal(rows.length, 2);
  // info filtered; warn + error remain (newest-first).
  assert.deepEqual(rows.map((r) => r.msg).sort(), ['e', 'w']);
});

test('retentionDaysOverrides shortens TTL and is enforced by sweep', async () => {
  // Override info events to expire after 1 day. Insert one with a
  // started_at 2 days in the past; sweep should remove it. Insert a
  // fresh one; sweep should keep it.
  await store.setAppSettings('app-a', {
    retentionDaysOverrides: { eventInfo: 1, spanOk: 1 },
  });

  const now = Date.now();
  const stale = now - 2 * 24 * 60 * 60 * 1000;
  await store.recordHandler(
    mkRecord({
      startedAt: stale,
      events: [{ ts: stale, level: 'info', msg: 'stale' }],
    }),
  );
  await store.recordHandler(
    mkRecord({
      spanId: 'fresh'.padEnd(16, 'f'),
      startedAt: now,
      events: [{ ts: now, level: 'info', msg: 'fresh' }],
    }),
  );

  store.sweep();
  const rows = await store.readEvents('app-a', { limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.msg, 'fresh');
});

test('deleteApp also drops the settings row', async () => {
  await store.setAppSettings('app-a', { enabled: false, minLevel: 'error' });
  await store.deleteApp('app-a');
  const s = await store.getAppSettings('app-a');
  assert.deepEqual(s, { enabled: true, minLevel: 'info' });
});

test('admission throttles writes past the per-second cap', async () => {
  // Build a store with a tiny token bucket and a fixed clock so we can
  // verify excess records are dropped, not queued.
  store.close();
  let nowMs = 1_000_000;
  store = new TelemetryStore(path.join(workspace, 'throttle.sqlite'), {
    sweepIntervalMs: 0,
    maxRecordsPerSec: 2,
    now: () => nowMs,
  });

  for (let i = 0; i < 5; i++) {
    await store.recordHandler(
      mkRecord({
        spanId: `${i}`.padEnd(16, '0'),
        startedAt: nowMs,
        events: [{ ts: nowMs, level: 'info', msg: `r${i}` }],
      }),
    );
  }

  const rows = await store.readEvents('app-a', { limit: 50 });
  // First 2 admitted, next 3 dropped before transaction.
  assert.equal(rows.length, 2);

  // Advance past the 1-second window and confirm admission resumes.
  nowMs += 1500;
  await store.recordHandler(
    mkRecord({
      spanId: 'after'.padEnd(16, 'a'),
      startedAt: nowMs,
      events: [{ ts: nowMs, level: 'info', msg: 'after' }],
    }),
  );
  const rows2 = await store.readEvents('app-a', { limit: 50 });
  assert.equal(rows2.length, 3);
});
