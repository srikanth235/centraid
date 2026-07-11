/*
 * Gateway log routes: the JSON tail + the replay-then-live SSE stream
 * over `GatewayLogStore`. Mock streaming req/res, same harness shape as
 * run-events-sse.test.ts.
 */

import { beforeEach, expect, test } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GatewayLogStore, type GatewayLogEntry } from '../serve/gateway-log-store.ts';
import { makeLogsRouteHandler } from './logs-routes.ts';

let store: GatewayLogStore;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

beforeEach(() => {
  store = new GatewayLogStore();
  handler = makeLogsRouteHandler(store);
});

interface MockClient {
  req: IncomingMessage;
  res: ServerResponse;
  status: () => number;
  body: () => string;
  events: () => GatewayLogEntry[];
  ended: () => boolean;
  close: () => void;
}

function client(url: string, method = 'GET'): MockClient {
  const chunks: string[] = [];
  let isEnded = false;
  let closeListener: (() => void) | undefined;
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
    method,
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
    body: () => chunks.join(''),
    ended: () => isEnded,
    close: () => closeListener?.(),
    events: () =>
      chunks
        .join('')
        .split('\n\n')
        .map((frame) => frame.split('\n').find((l) => l.startsWith('data: ')))
        .filter((l): l is string => l !== undefined)
        .map((l) => JSON.parse(l.slice('data: '.length)) as GatewayLogEntry),
  };
}

test('ignores unrelated URLs', async () => {
  const c = client('/centraid/_gateway/info');
  expect(await handler(c.req, c.res)).toBe(false);
});

test('GET /centraid/_logs returns the buffered tail as JSON', async () => {
  store.append('info', 'one');
  store.append('warn', 'two');

  const c = client('/centraid/_logs');
  expect(await handler(c.req, c.res)).toBe(true);
  expect(c.status()).toBe(200);
  const parsed = JSON.parse(c.body()) as { entries: GatewayLogEntry[] };
  expect(parsed.entries.map((e) => e.message)).toEqual(['one', 'two']);
});

test('JSON tail honors ?after= and ?limit= (newest win the cap)', async () => {
  for (let i = 1; i <= 5; i++) store.append('info', `line ${i}`);

  const after = client('/centraid/_logs?after=3');
  await handler(after.req, after.res);
  expect(
    (JSON.parse(after.body()) as { entries: GatewayLogEntry[] }).entries.map((e) => e.message),
  ).toEqual(['line 4', 'line 5']);

  const limited = client('/centraid/_logs?limit=2');
  await handler(limited.req, limited.res);
  expect(
    (JSON.parse(limited.body()) as { entries: GatewayLogEntry[] }).entries.map((e) => e.message),
  ).toEqual(['line 4', 'line 5']);
});

test('non-GET is a 405', async () => {
  const c = client('/centraid/_logs', 'POST');
  expect(await handler(c.req, c.res)).toBe(true);
  expect(c.status()).toBe(405);
});

test('SSE replays the buffer then streams live entries', async () => {
  store.append('info', 'boot line');

  const c = client('/centraid/_logs/events');
  expect(await handler(c.req, c.res)).toBe(true);
  expect(c.status()).toBe(200);

  // Replay landed, stream still open, subscriber registered.
  expect(c.events().map((e) => e.message)).toEqual(['boot line']);
  expect(c.ended()).toBe(false);
  expect(store.subscriberCount()).toBe(1);

  store.append('error', 'live failure');
  const evs = c.events();
  expect(evs.map((e) => e.message)).toEqual(['boot line', 'live failure']);
  expect(evs[1]?.level).toBe('error');
  // seq-ordered, gapless.
  expect(evs.map((e) => e.seq)).toEqual([1, 2]);
});

test('SSE ?after= skips already-seen entries on reconnect', async () => {
  store.append('info', 'seen');
  store.append('info', 'unseen');

  const c = client('/centraid/_logs/events?after=1');
  await handler(c.req, c.res);
  expect(c.events().map((e) => e.message)).toEqual(['unseen']);
});

test('client disconnect unsubscribes and ends the response', async () => {
  const c = client('/centraid/_logs/events');
  await handler(c.req, c.res);
  expect(store.subscriberCount()).toBe(1);

  c.close();
  expect(store.subscriberCount()).toBe(0);
  expect(c.ended()).toBe(true);

  // A line after disconnect reaches no one and doesn't throw.
  store.append('info', 'after close');
});
