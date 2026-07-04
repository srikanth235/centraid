/*
 * Automation/insights HTTP routes (issue #141). Drives
 * `makeAutomationsRouteHandler` with mock req/res, real (empty) stores
 * over a tempdir, and a stub `runAutomation` so run-now is observable
 * without spawning a CLI.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AnalyticsStore, InsightsStore, makeTranscriptsDbProvider } from '@centraid/app-engine';
import { WorktreeStore } from '../worktree-store/index.js';
import { makeAutomationsRouteHandler } from './automations-routes.ts';

let dir: string;
let analytics: AnalyticsStore;
let insights: InsightsStore;
let fired: Array<{ automationRef: string; runId: string }>;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), `auto-routes-${crypto.randomUUID()}-`));
  const transcriptsDbFile = path.join(dir, 'transcripts.db');
  const provider = makeTranscriptsDbProvider(transcriptsDbFile);
  analytics = new AnalyticsStore(provider);
  insights = new InsightsStore(provider);
  fired = [];
  handler = makeAutomationsRouteHandler({
    store: new WorktreeStore({ root: path.join(dir, 'code') }),
    transcriptsDbFile,
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
