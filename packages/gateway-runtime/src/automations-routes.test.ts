/*
 * Automation/insights HTTP routes (issue #141). Drives
 * `makeAutomationsRouteHandler` with mock req/res, real (empty) stores
 * over a tempdir, and a stub `runAutomation` so run-now is observable
 * without spawning a CLI.
 */

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AnalyticsStore, InsightsStore, makeAnalyticsDbProvider } from '@centraid/runtime-core';
import { AppsStore } from '@centraid/apps-store';
import { makeAutomationsRouteHandler } from './automations-routes.ts';

let dir: string;
let analytics: AnalyticsStore;
let insights: InsightsStore;
let fired: Array<{ automationRef: string; runId: string }>;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), `auto-routes-${crypto.randomUUID()}-`));
  const provider = makeAnalyticsDbProvider(path.join(dir, 'analytics.sqlite'));
  analytics = new AnalyticsStore(provider);
  insights = new InsightsStore(provider);
  fired = [];
  handler = makeAutomationsRouteHandler({
    store: new AppsStore({ root: path.join(dir, 'code') }),
    dataAppsDir: path.join(dir, 'apps'),
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
  assert.equal(r.owned, false);
});

test('GET /centraid/_automations lists (empty store)', async () => {
  const r = await call('GET', '/centraid/_automations');
  assert.equal(r.owned, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { rows: [], errors: [] });
});

test('GET /centraid/_automations/read?ref= returns null when absent', async () => {
  const r = await call('GET', '/centraid/_automations/read?ref=appx/x');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { row: null });
});

test('POST run-now mints a runId and invokes the injected runAutomation', async () => {
  const r = await call('POST', '/centraid/_automations/run-now?ref=brief/brief');
  assert.equal(r.status, 202);
  const { runId } = r.body as { runId: string };
  assert.match(runId, /^brief\/brief:\d+:[0-9a-f]{8}$/);
  assert.deepEqual(fired, [{ automationRef: 'brief/brief', runId }]);
});

test('POST run-now without ?ref= is a 400', async () => {
  const r = await call('POST', '/centraid/_automations/run-now');
  assert.equal(r.status, 400);
  assert.equal(fired.length, 0);
});

test('GET /centraid/_automations/runs returns an empty feed', async () => {
  const r = await call('GET', '/centraid/_automations/runs?limit=10');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { runs: [] });
});

test('GET /centraid/_automations/run?runId= returns null for an unknown run', async () => {
  const r = await call('GET', '/centraid/_automations/run?runId=appx/x:1:deadbeef');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { run: null });
});

test('GET /centraid/_insights/summary returns a payload object', async () => {
  const r = await call('GET', '/centraid/_insights/summary?windowDays=30');
  assert.equal(r.owned, true);
  assert.equal(r.status, 200);
  assert.equal(typeof r.body, 'object');
  assert.notEqual(r.body, null);
});
