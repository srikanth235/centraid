import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeDataPlaneControlHandler } from './data-plane-control.js';

async function invokeRoute(
  handler: ReturnType<typeof makeDataPlaneControlHandler>,
  input: { method: string; url: string; headers?: Record<string, string>; body?: unknown },
) {
  let statusCode = 0;
  let body = '';
  const req = Readable.from(
    input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body))],
  ) as IncomingMessage;
  req.method = input.method;
  req.url = input.url;
  req.headers = input.headers ?? {};
  const res = {
    writableEnded: false,
    setHeader: () => undefined,
    end(this: { writableEnded: boolean }, value?: string | Buffer) {
      if (value) body += value.toString();
      this.writableEnded = true;
    },
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
  } as unknown as ServerResponse;
  await handler(req, res);
  return { statusCode, json: () => JSON.parse(body) as unknown };
}

test('native relay authorization requires the control secret', async () => {
  const handler = makeDataPlaneControlHandler({
    secret: '0123456789abcdef0123456789abcdef',
    authorize: (endpointId) => ({
      allowed: endpointId === 'paired',
      headers: { 'x-device': endpointId },
    }),
    pair: () => ({ ok: false }),
  });
  const refused = await invokeRoute(handler, {
    method: 'GET',
    url: '/centraid/_gateway/tunnel/authorize?endpointId=paired',
  });
  expect(refused.statusCode).toBe(403);
  const allowed = await invokeRoute(handler, {
    method: 'GET',
    url: '/centraid/_gateway/tunnel/authorize?endpointId=paired',
    headers: { 'x-centraid-data-plane-secret': '0123456789abcdef0123456789abcdef' },
  });
  expect(allowed.json()).toEqual({ allowed: true, headers: { 'x-device': 'paired' } });
});

test('native relay pairing delegates metadata only after control authentication', async () => {
  const pair = vi.fn(() => ({ ok: true, gatewayId: 'gateway' }));
  const handler = makeDataPlaneControlHandler({
    secret: '0123456789abcdef0123456789abcdef',
    authorize: () => ({ allowed: false }),
    pair,
  });
  const body = { ticketId: 'ticket', secret: 'once' };
  const refused = await invokeRoute(handler, {
    method: 'POST',
    url: '/centraid/_gateway/tunnel/pair?endpointId=device',
    body,
  });
  expect(refused.statusCode).toBe(403);
  expect(pair).not.toHaveBeenCalled();

  const allowed = await invokeRoute(handler, {
    method: 'POST',
    url: '/centraid/_gateway/tunnel/pair?endpointId=device',
    headers: { 'x-centraid-data-plane-secret': '0123456789abcdef0123456789abcdef' },
    body,
  });
  expect(allowed.statusCode).toBe(200);
  expect(pair).toHaveBeenCalledWith(body, 'device');
});
