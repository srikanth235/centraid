import { tempDirSync } from '@centraid/test-kit/temp-dir';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, test } from 'vitest';
import {
  writeFileMap,
  readFileMap,
  sendJson,
  sendError,
  readBody,
  readJson,
  fileExists,
} from './route-helpers.js';

function tmp(): string {
  return tempDirSync('centraid-route-helpers-');
}

function mockReq(body: string | Buffer): IncomingMessage {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return Readable.from([buf]) as unknown as IncomingMessage;
}

function mockRes(): { res: ServerResponse; out: { status: number; body: string } } {
  const out = { status: 0, body: '' };
  const res = {
    statusCode: 0,
    setHeader() {},
    end(text?: string) {
      out.status = res.statusCode;
      out.body = text ?? '';
    },
  } as unknown as ServerResponse;
  return { res, out };
}

const servers: http.Server[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function endpoint(body: unknown): Promise<string> {
  const server = http.createServer((_req, res) => {
    sendJson(res, 200, body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('gateway-native JSON compresses large responses asynchronously (#456 C8)', async () => {
  const body = { rows: Array.from({ length: 500 }, (_, id) => ({ id, title: `row-${id}` })) };
  const response = await fetch(await endpoint(body), { headers: { 'accept-encoding': 'br' } });
  expect(response.headers.get('content-encoding')).toBe('br');
  expect(response.headers.get('vary')).toContain('Accept-Encoding');
  expect(await response.json()).toEqual(body);
});

test('small JSON avoids compression overhead', async () => {
  const response = await fetch(await endpoint({ ok: true }), {
    headers: { 'accept-encoding': 'br' },
  });
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(await response.json()).toEqual({ ok: true });
});

test('encoding negotiation honors explicit q=0 exclusions', async () => {
  const body = { rows: Array.from({ length: 500 }, (_, id) => ({ id, title: `row-${id}` })) };
  const response = await fetch(await endpoint(body), {
    headers: { 'accept-encoding': 'br;q=0, gzip;q=0.7' },
  });
  expect(response.headers.get('content-encoding')).toBe('gzip');
  expect(await response.json()).toEqual(body);
});

describe('writeFileMap / readFileMap', () => {
  it('round-trips a file map, creating parent dirs and skipping non-editable/dotfiles', async () => {
    const dir = tmp();
    await writeFileMap(dir, [
      { path: 'index.html', content: '<h1>hi</h1>' },
      { path: 'nested/app.js', content: 'export const x = 1;' },
      { path: 'blob.bin', content: 'not-editable' },
      { path: '.secret', content: 'dotfile' },
    ]);
    expect(readFileSync(join(dir, 'nested/app.js'), 'utf8')).toBe('export const x = 1;');
    const map = await readFileMap(dir);
    // Sorted, text-only, no dotfiles or non-editable extensions.
    expect(map.map((f) => f.path)).toEqual(['index.html', 'nested/app.js']);
  });

  it('refuses to write outside the app dir', async () => {
    const dir = tmp();
    await expect(writeFileMap(dir, [{ path: '../escape.ts', content: 'x' }])).rejects.toThrow(
      /outside the app/,
    );
  });

  it('reads a missing dir as an empty map', async () => {
    expect(await readFileMap(join(tmp(), 'does-not-exist'))).toEqual([]);
  });
});

describe('sendJson / sendError', () => {
  it('sendJson writes status + JSON body', () => {
    const { res, out } = mockRes();
    expect(sendJson(res, 201, { ok: true })).toBe(true);
    expect(out.status).toBe(201);
    expect(JSON.parse(out.body)).toEqual({ ok: true });
  });

  it('sendError wraps an Error as a 500 internal_error', () => {
    const { res, out } = mockRes();
    sendError(res, new Error('kaboom'));
    expect(out.status).toBe(500);
    expect(JSON.parse(out.body)).toEqual({ error: 'internal_error', message: 'kaboom' });
  });

  it('sendError stringifies a non-Error throw', () => {
    const { res, out } = mockRes();
    sendError(res, 'plain string');
    expect(JSON.parse(out.body).message).toBe('plain string');
  });
});

describe('readBody / readJson', () => {
  it('reads and concatenates the request body', async () => {
    expect((await readBody(mockReq('hello'))).toString('utf8')).toBe('hello');
  });

  it('throws when the body exceeds the cap', async () => {
    await expect(readBody(mockReq('way too long'), 4)).rejects.toThrow(/too large/);
  });

  it('parses a JSON object body', async () => {
    expect(await readJson(mockReq('{"a":1}'))).toEqual({ a: 1 });
  });

  it('returns {} for an empty body', async () => {
    expect(await readJson(mockReq(''))).toEqual({});
  });

  it('rejects a non-object JSON body', async () => {
    await expect(readJson(mockReq('[1,2,3]'))).rejects.toThrow(/must be a JSON object/);
  });
});

describe('fileExists', () => {
  it('is true for a file and false for a missing path', async () => {
    const dir = tmp();
    await writeFileMap(dir, [{ path: 'a.txt', content: 'x' }]);
    expect(await fileExists(join(dir, 'a.txt'))).toBe(true);
    expect(await fileExists(join(dir, 'nope.txt'))).toBe(false);
  });
});
