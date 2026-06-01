/*
 * SSE streaming for automation runs (issue #158): the
 * `GET /centraid/_automations/run/events?runId=` endpoint. Drives
 * `makeAutomationsRouteHandler` with a mock streaming req/res, a real
 * per-app run ledger over a tempdir, and a `RunEventBus` for the live path.
 */

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentRunsStore, makeRuntimeDbProvider, type RunStreamEvent } from '@centraid/app-engine';
import { AnalyticsStore, InsightsStore, makeAnalyticsDbProvider } from '@centraid/analytics';
import { WorktreeStore } from '@centraid/worktree-store';
import { makeAutomationsRouteHandler } from './automations-routes.ts';
import { RunEventBus } from './run-event-bus.ts';

let dir: string;
let analytics: AnalyticsStore;
let bus: RunEventBus;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const APP = 'brief';

/** Open a ledger at the path the route resolves for `<APP>/...` run ids. */
function ledger(): AgentRunsStore {
  return new AgentRunsStore(makeRuntimeDbProvider(path.join(dir, 'apps', APP, 'runtime.sqlite')));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), `run-sse-${crypto.randomUUID()}-`));
  await fs.mkdir(path.join(dir, 'apps', APP), { recursive: true });
  const provider = makeAnalyticsDbProvider(path.join(dir, 'analytics.sqlite'));
  analytics = new AnalyticsStore(provider);
  bus = new RunEventBus();
  handler = makeAutomationsRouteHandler({
    store: new WorktreeStore({ root: path.join(dir, 'code') }),
    dataAppsDir: path.join(dir, 'apps'),
    analytics,
    insights: new InsightsStore(provider),
    runAutomation: () => undefined,
    subscribeRunEvents: (runId, listener) => bus.subscribe(runId, listener),
  });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface SseClient {
  req: IncomingMessage;
  res: ServerResponse;
  events: () => RunStreamEvent[];
  ended: () => boolean;
}

function sseClient(url: string): SseClient {
  const chunks: string[] = [];
  let isEnded = false;
  const res = {
    writableEnded: false,
    statusCode: 0,
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    setHeader() {},
    write(s: string) {
      chunks.push(s);
      return true;
    },
    end() {
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
    on() {
      return this;
    },
  };
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    ended: () => isEnded,
    events: () =>
      chunks
        .join('')
        .split('\n\n')
        .map((frame) => frame.split('\n').find((l) => l.startsWith('data: ')))
        .filter((l): l is string => l !== undefined)
        .map((l) => JSON.parse(l.slice('data: '.length)) as RunStreamEvent),
  };
}

test('replays a finished run from the ledger then closes', async () => {
  const runId = `${APP}/digest:${Date.now()}:abcd1234`;
  const store = ledger();
  store.insertRun({ runId, automationId: `${APP}/digest`, triggerKind: 'manual', startedAt: 1 });
  store.openNode({ nodeId: 'n0', runId, ordinal: 0, kind: 'tool', name: 'http.get', startedAt: 2 });
  store.closeNode({
    nodeId: 'n0',
    ok: true,
    outputJson: '{"status":200}',
    endedAt: 5,
    durationMs: 3,
  });
  store.finishRun({ runId, endedAt: 6, ok: true, summary: 'done' });

  const c = sseClient(`/centraid/_automations/run/events?runId=${encodeURIComponent(runId)}`);
  const owned = await handler(c.req, c.res);

  assert.equal(owned, true);
  assert.equal(c.res.statusCode, 200);
  assert.equal(c.ended(), true, 'a finished run closes after replay');
  const evs = c.events();
  assert.deepEqual(
    evs.map((e) => e.type),
    ['run.start', 'node.start', 'node.end', 'run.end'],
  );
  const end = evs[3] as Extract<RunStreamEvent, { type: 'run.end' }>;
  assert.equal(end.ok, true);
  // No live subscriber should linger for a closed run.
  assert.equal(bus.subscriberCount(runId), 0);
});

test('joins an in-flight run: replays the open node, then streams live to run.end', async () => {
  const runId = `${APP}/watch:${Date.now()}:beef0000`;
  const store = ledger();
  store.insertRun({ runId, automationId: `${APP}/watch`, triggerKind: 'manual', startedAt: 1 });
  // One node already running (opened, not closed) when the viewer joins.
  store.openNode({ nodeId: 'n0', runId, ordinal: 0, kind: 'agent', name: 'agent', startedAt: 2 });

  const c = sseClient(`/centraid/_automations/run/events?runId=${encodeURIComponent(runId)}`);
  await handler(c.req, c.res);

  // Replay: run.start + the open node's start (no end yet). Still live.
  assert.deepEqual(
    c.events().map((e) => e.type),
    ['run.start', 'node.start'],
  );
  assert.equal(c.ended(), false);
  assert.equal(bus.subscriberCount(runId), 1, 'subscribed to live events');

  // The fire finishes the node and the run — delivered live off the bus.
  bus.publish(runId, { type: 'node.end', ordinal: 0, ok: true, result: 'hi', durationMs: 40 });
  bus.publish(runId, { type: 'run.end', ok: true });

  assert.deepEqual(
    c.events().map((e) => e.type),
    ['run.start', 'node.start', 'node.end', 'run.end'],
  );
  assert.equal(c.ended(), true, 'run.end closes the stream');
  assert.equal(bus.subscriberCount(runId), 0, 'unsubscribed on close');
});

test('a fire that fails before the ledger opens still closes via a bus run.end', async () => {
  // No insertRun: `fireAutomation` threw before the handler runner opened the
  // ledger (bad ref / automation gone / dispatch setup failure). `run-now`
  // already handed the caller this runId and the viewer subscribed, so without
  // a terminal event the stream would hang. build-gateway's catch publishes a
  // synthetic run.end — this proves the SSE side honors it and closes.
  const runId = `${APP}/broken:${Date.now()}:dead0000`;
  const c = sseClient(`/centraid/_automations/run/events?runId=${encodeURIComponent(runId)}`);
  await handler(c.req, c.res);

  // Synthetic run.start written, no ledger nodes, still live on the bus.
  assert.deepEqual(
    c.events().map((e) => e.type),
    ['run.start'],
  );
  assert.equal(c.ended(), false);
  assert.equal(bus.subscriberCount(runId), 1);

  bus.publish(runId, { type: 'run.end', ok: false, error: 'automation not found' });

  const evs = c.events();
  assert.deepEqual(
    evs.map((e) => e.type),
    ['run.start', 'run.end'],
  );
  const end = evs[1] as Extract<RunStreamEvent, { type: 'run.end' }>;
  assert.equal(end.ok, false);
  assert.equal(end.error, 'automation not found');
  assert.equal(c.ended(), true, 'the stream closes instead of hanging');
  assert.equal(bus.subscriberCount(runId), 0);
});

test('run/events without ?runId= is a 400', async () => {
  const c = sseClient('/centraid/_automations/run/events');
  await handler(c.req, c.res);
  assert.equal(c.res.statusCode, 400);
});
