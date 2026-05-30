import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Runtime } from './runtime.ts';
import { startRuntimeHttpServer, type RuntimeHttpServerHandle } from './http-server.ts';

let workspace: string;
let server: RuntimeHttpServerHandle;
let runtime: Runtime;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), `sse-${crypto.randomUUID()}-`));
  runtime = new Runtime({ appsDir: workspace });
  server = await startRuntimeHttpServer({ runtime });
  await runtime.bootstrap();
});

afterEach(async () => {
  await server.close().catch(() => undefined);
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * Read SSE frames until the predicate returns truthy. Returns the parsed
 * data payloads of `event: change` frames seen so far. Cancels the response
 * reader when done so the connection can close cleanly.
 */
type ChangeEvt = {
  tables: string[];
  source?: string;
  toolCallId?: string;
  agentTurnId?: string;
};

async function readChangeEvents(
  res: Response,
  predicate: (events: ChangeEvt[]) => boolean,
  timeoutMs = 2000,
): Promise<ChangeEvt[]> {
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const out: ChangeEvt[] = [];
  let buf = '';
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value?: undefined; done?: undefined }>((resolve) =>
          setTimeout(() => resolve({}), 100),
        ),
      ]);
      if (done) break;
      if (value) {
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by blank lines.
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          let isChange = false;
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event: change')) isChange = true;
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (isChange && data) {
            try {
              out.push(JSON.parse(data) as ChangeEvt);
            } catch {
              /* skip non-JSON */
            }
          }
        }
      }
      if (predicate(out)) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* swallow */
    }
  }
  return out;
}

test('SSE: delivers a change event when the bus emits for the subscribed app', async () => {
  const res = await fetch(`${server.url}/centraid/myapp/_changes`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  // Emit after the connection is open. We use the bus directly because the
  // /_changes endpoint is the consumer side; producers are tested elsewhere.
  setTimeout(() => {
    runtime.changeBus.emit({
      appId: 'myapp',
      tables: ['todos'],
      ts: 1234,
      source: 'handler',
    });
  }, 50);

  const events = await readChangeEvents(res, (e) => e.length >= 1);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.tables, ['todos']);
});

test('SSE: does not deliver events for OTHER apps to this subscriber', async () => {
  const res = await fetch(`${server.url}/centraid/myapp/_changes`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 200);

  setTimeout(() => {
    runtime.changeBus.emit({ appId: 'otherapp', tables: ['x'], ts: 1, source: 'handler' });
    runtime.changeBus.emit({ appId: 'myapp', tables: ['todos'], ts: 2, source: 'handler' });
  }, 50);

  const events = await readChangeEvents(res, (e) => e.length >= 1);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.tables, ['todos']);
});

test('SSE: client disconnect unsubscribes the listener from the bus', async () => {
  const res = await fetch(`${server.url}/centraid/cleanup-app/_changes`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 200);
  // Drain a tiny bit so the connection is fully established and the
  // subscribe() has run on the server.
  const reader = res.body!.getReader();
  await Promise.race([reader.read(), new Promise((resolve) => setTimeout(resolve, 50))]);
  assert.equal(runtime.changeBus.listenerCount('cleanup-app'), 1);

  // Cancel the reader → underlying socket closes → server cleanup fires.
  await reader.cancel();
  // The cleanup runs on the next tick of the close event; give it a
  // moment to propagate.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runtime.changeBus.listenerCount('cleanup-app'), 0);
});

test('SSE: requires the bearer token (gated by the surrounding http-server)', async () => {
  const res = await fetch(`${server.url}/centraid/myapp/_changes`);
  assert.equal(res.status, 401);
});

test('SSE: agent-sourced events carry source, toolCallId, and agentTurnId', async () => {
  const res = await fetch(`${server.url}/centraid/myapp/_changes`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 200);

  setTimeout(() => {
    runtime.changeBus.emit({
      appId: 'myapp',
      tables: ['todos'],
      ts: 5,
      source: 'agent',
      toolCallId: 'call-abc',
      agentTurnId: 'turn-xyz',
    });
  }, 50);

  const events = await readChangeEvents(res, (e) => e.length >= 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.source, 'agent');
  assert.equal(events[0]!.toolCallId, 'call-abc');
  assert.equal(events[0]!.agentTurnId, 'turn-xyz');
});

test('SSE: handler-sourced events carry source but omit toolCallId/agentTurnId', async () => {
  const res = await fetch(`${server.url}/centraid/myapp/_changes`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 200);

  setTimeout(() => {
    runtime.changeBus.emit({
      appId: 'myapp',
      tables: ['notes'],
      ts: 6,
      source: 'handler',
    });
  }, 50);

  const events = await readChangeEvents(res, (e) => e.length >= 1);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.source, 'handler');
  assert.equal(events[0]!.toolCallId, undefined);
  assert.equal(events[0]!.agentTurnId, undefined);
});
