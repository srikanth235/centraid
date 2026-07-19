import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Automation/insights HTTP routes (issue #141). Drives
 * `makeAutomationsRouteHandler` with mock req/res, real (empty) stores
 * over a tempdir, and a stub `runAutomation` so run-now is observable
 * without spawning a CLI.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AnalyticsStore,
  ConversationStore,
  InsightsStore,
  makeJournalDbProvider,
} from '@centraid/app-engine';
import { WorktreeStore } from '../worktree-store/index.js';
import { makeAutomationsRouteHandler } from './automations-routes.ts';
import { SseSubscriberCap } from './sse-cap.ts';

let dir: string;
let analytics: AnalyticsStore;
let insights: InsightsStore;
let fired: Array<{ automationRef: string; runId: string }>;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

beforeEach(async () => {
  dir = await tempDir(`auto-routes-${crypto.randomUUID()}-`);
  const journalDbFile = path.join(dir, 'journal.db');
  const provider = makeJournalDbProvider(journalDbFile);
  analytics = new AnalyticsStore(provider);
  insights = new InsightsStore(provider);
  fired = [];
  handler = makeAutomationsRouteHandler({
    store: new WorktreeStore({ root: path.join(dir, 'code') }),
    journalDbFile,
    analytics,
    insights,
    runAutomation: (input) => fired.push(input),
  });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface Captured {
  owned: boolean;
  status: number;
  body: unknown;
}

async function call(method: string, url: string, jsonBody?: unknown): Promise<Captured> {
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (jsonBody !== undefined) yield Buffer.from(JSON.stringify(jsonBody));
    },
  } as unknown as IncomingMessage;
  let raw = '';
  const res = {
    statusCode: 0,
    setHeader() {},
    end(b?: string) {
      raw = b ?? '';
    },
  };
  const owned = await handler(req, res as unknown as ServerResponse);
  return { owned, status: res.statusCode, body: raw ? JSON.parse(raw) : null };
}

test('ignores paths it does not own', async () => {
  const r = await call('GET', '/centraid/_apps');
  expect(r.owned).toBe(false);
});

test('GET /centraid/_automations lists (empty store)', async () => {
  const r = await call('GET', '/centraid/_automations');
  expect(r.owned).toBe(true);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ rows: [], errors: [] });
});

test('GET /centraid/_automations/read?ref= returns null when absent', async () => {
  const r = await call('GET', '/centraid/_automations/read?ref=appx/x');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ row: null });
});

test('POST run-now mints a runId and invokes the injected runAutomation', async () => {
  const r = await call('POST', '/centraid/_automations/run-now?ref=brief/brief');
  expect(r.status).toBe(202);
  const { runId } = r.body as { runId: string };
  expect(runId).toMatch(/^brief\/brief:\d+:[0-9a-f]{8}$/);
  expect(fired).toEqual([{ automationRef: 'brief/brief', runId }]);
});

test('POST run-now without ?ref= is a 400', async () => {
  const r = await call('POST', '/centraid/_automations/run-now');
  expect(r.status).toBe(400);
  expect(fired.length).toBe(0);
});

test('GET /centraid/_automations/runs returns an empty feed', async () => {
  const r = await call('GET', '/centraid/_automations/runs?limit=10');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ runs: [] });
});

// The `run_summary` view only covers finished turns; the thread screen stays
// put on "Run now", so the ref-scoped feed must surface an IN-FLIGHT fire
// (started, not ended) as a running record or a slow run is invisible.
test('GET runs includes an in-flight fire in both thread and global feeds', async () => {
  const store = new ConversationStore(makeJournalDbProvider(path.join(dir, 'journal.db')));
  const ref = 'brief/brief';
  const conversationId = store.ensureAutomationConversation(ref, 'brief', 'Brief');
  store.insertTurn({
    turnId: `${ref}:100:aaaaaaaa`,
    conversationId,
    triggerKind: 'manual',
    triggerOrigin: 'manual',
    startedAt: 100,
  });
  store.insertTurn({
    turnId: `${ref}:50:bbbbbbbb`,
    conversationId,
    triggerKind: 'manual',
    triggerOrigin: 'manual',
    startedAt: 50,
  });
  store.finishTurn({ turnId: `${ref}:50:bbbbbbbb`, endedAt: 60, ok: true });

  const r = await call('GET', `/centraid/_automations/runs?ref=${encodeURIComponent(ref)}`);
  expect(r.status).toBe(200);
  const runs = (r.body as { runs: Array<{ runId: string; endedAt?: number; ok: boolean }> }).runs;
  expect(runs.map((x) => x.runId)).toEqual([`${ref}:100:aaaaaaaa`, `${ref}:50:bbbbbbbb`]);
  expect(runs[0]?.endedAt).toBeUndefined(); // in-flight → renders as "running"
  expect(runs[1]?.endedAt).toBe(60);
  // No ref filter → the fleet activity feed also sees the in-flight turn.
  const all = await call('GET', '/centraid/_automations/runs?limit=10');
  const allRuns = (all.body as { runs: Array<{ runId: string }> }).runs;
  expect(allRuns.map((x) => x.runId)).toEqual([`${ref}:100:aaaaaaaa`, `${ref}:50:bbbbbbbb`]);
});

test('GET /centraid/_automations/run?runId= returns null for an unknown run', async () => {
  const r = await call('GET', '/centraid/_automations/run?runId=appx/x:1:deadbeef');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ run: null });
});

test('GET /centraid/_insights/summary returns a payload object', async () => {
  const r = await call('GET', '/centraid/_insights/summary?windowDays=30');
  expect(r.owned).toBe(true);
  expect(r.status).toBe(200);
  expect(typeof r.body).toBe('object');
  expect(r.body).not.toBe(null);
});

// Issue #351: run/events SSE was unbounded — a small cap (2) makes the
// "cap+1" scenario cheap to exercise. `subscribeRunEvents` is wired to a
// no-op unsub (never fires `run.end`) so the stream stays open under test,
// same as a real live run being watched.
interface SseMockClient {
  req: IncomingMessage;
  res: ServerResponse;
  status: () => number;
  header: (name: string) => string | undefined;
  body: () => string;
  ended: () => boolean;
  close: () => void;
}

function sseClient(url: string): SseMockClient {
  const chunks: string[] = [];
  const headers = new Map<string, string>();
  let isEnded = false;
  let closeListener: (() => void) | undefined;
  const res = {
    writableEnded: false,
    statusCode: 0,
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    write(s: string) {
      chunks.push(s);
      return true;
    },
    end(s?: string) {
      if (s) chunks.push(s);
      isEnded = true;
      this.writableEnded = true;
    },
    on() {
      return this;
    },
  };
  const req = {
    method: 'GET',
    url,
    on(event: string, fn: () => void) {
      if (event === 'close') closeListener = fn;
      return this;
    },
  };
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    status: () => res.statusCode,
    header: (name: string) => headers.get(name.toLowerCase()),
    body: () => chunks.join(''),
    ended: () => isEnded,
    close: () => closeListener?.(),
  };
}

test('run/events subscribers past the cap get 503 + Retry-After; the count decrements on disconnect', async () => {
  const cap = new SseSubscriberCap(2);
  const capped = makeAutomationsRouteHandler({
    store: new WorktreeStore({ root: path.join(dir, 'code') }),
    journalDbFile: path.join(dir, 'journal.db'),
    analytics,
    insights,
    runAutomation: (input) => fired.push(input),
    subscribeRunEvents: () => () => undefined, // keeps the stream open, like a real live run
    subscriberCap: cap,
  });

  const a = sseClient('/centraid/_automations/run/events?runId=r1');
  const b = sseClient('/centraid/_automations/run/events?runId=r2');
  expect(await capped(a.req, a.res)).toBe(true);
  expect(await capped(b.req, b.res)).toBe(true);
  expect(a.status()).toBe(200);
  expect(b.status()).toBe(200);
  expect(cap.current()).toBe(2);

  const c = sseClient('/centraid/_automations/run/events?runId=r3');
  expect(await capped(c.req, c.res)).toBe(true);
  expect(c.status()).toBe(503);
  expect(c.header('Retry-After')).toBeDefined();
  const errBody = JSON.parse(c.body()) as { error: string };
  expect(errBody.error).toBe('sse_capacity');
  expect(c.ended()).toBe(true);
  expect(cap.current()).toBe(2);

  a.close();
  expect(cap.current()).toBe(1);
  const d = sseClient('/centraid/_automations/run/events?runId=r4');
  expect(await capped(d.req, d.res)).toBe(true);
  expect(d.status()).toBe(200);
  expect(cap.current()).toBe(2);
});
