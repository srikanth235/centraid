import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openChatStream } from './chat-client.ts';
import type { ChatStreamEvent } from '@centraid/runtime-core';

let server: http.Server;
let url: string;

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void,
): Promise<void> {
  server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  url = `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  // Make sure stale state from previous test never leaks.
  url = '';
});

test('parses a multi-event SSE stream into ChatStreamEvents', async () => {
  await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      assert.match(req.url ?? '', /\/centraid\/demo\/_chat$/);
      assert.equal(req.method, 'POST');
      const parsed = JSON.parse(body) as { windowId: string; message: string };
      assert.equal(parsed.windowId, 'w1');
      assert.equal(parsed.message, 'hello');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`: connected\n\n`);
      res.write(`event: assistant.start\ndata: {"type":"assistant.start"}\n\n`);
      res.write(`event: assistant.delta\ndata: {"type":"assistant.delta","delta":"Hi"}\n\n`);
      res.write(`event: assistant.delta\ndata: {"type":"assistant.delta","delta":" there"}\n\n`);
      res.write(`event: final\ndata: {"type":"final","text":"Hi there"}\n\n`);
      res.write(`event: end\ndata: {}\n\n`);
      res.end();
    });
  });

  const handle = await openChatStream({
    config: { gatewayUrl: url, gatewayToken: 'tok' },
    appId: 'demo',
    windowId: 'w1',
    message: 'hello',
  });
  const events: ChatStreamEvent[] = [];
  for await (const ev of handle.events) events.push(ev);
  assert.equal(events.length, 4);
  assert.equal(events[0]?.type, 'assistant.start');
  assert.equal(events[1]?.type, 'assistant.delta');
  if (events[1]?.type === 'assistant.delta') assert.equal(events[1].delta, 'Hi');
  assert.equal(events[3]?.type, 'final');
});

test('sends Bearer token when gatewayToken is set', async () => {
  let received: string | undefined;
  await startServer((req, res) => {
    received = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: end\ndata: {}\n\n`);
    res.end();
  });
  const handle = await openChatStream({
    config: { gatewayUrl: url, gatewayToken: 'secret-token' },
    appId: 'demo',
    windowId: 'w1',
    message: 'hi',
  });
  for await (const _ev of handle.events) {
    // drain
  }
  assert.equal(received, 'Bearer secret-token');
});

test('throws ChatHarnessError on non-2xx response', async () => {
  await startServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no_chat_runner' }));
  });
  await assert.rejects(
    () =>
      openChatStream({
        config: { gatewayUrl: url },
        appId: 'demo',
        windowId: 'w1',
        message: 'hi',
      }),
    /HTTP 503/,
  );
});

test('forwards model parameter in the POST body', async () => {
  let parsedBody: Record<string, unknown> | undefined;
  await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      parsedBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: end\ndata: {}\n\n`);
      res.end();
    });
  });
  const handle = await openChatStream({
    config: { gatewayUrl: url },
    appId: 'demo',
    windowId: 'w1',
    message: 'hi',
    model: 'claude-opus-4-7',
  });
  for await (const _ev of handle.events) {
    // drain
  }
  assert.equal(parsedBody?.model, 'claude-opus-4-7');
});
