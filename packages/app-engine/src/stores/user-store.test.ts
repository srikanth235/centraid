import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserStore, makeUserStoreRouteHandler } from './user-store.js';
import { makeGatewayDbProvider } from './gateway-db.js';
import { IncomingMessage, ServerResponse } from 'node:http';

function newStore(): UserStore {
  // Each test gets its own DB file so cases stay isolated.
  const dir = mkdtempSync(join(tmpdir(), 'centraid-user-store-'));
  return new UserStore(makeGatewayDbProvider(join(dir, 'db.sqlite')));
}

describe('UserStore', () => {
  it('returns the same UUID across calls', () => {
    const s = newStore();
    const a = s.getUserId();
    const b = s.getUserId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('persists the UUID across instances pointed at the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'centraid-user-store-'));
    const file = join(dir, 'db.sqlite');
    // Two providers, two UserStores, same file — they should agree on
    // the identity row.
    const a = new UserStore(makeGatewayDbProvider(file)).getUserId();
    const b = new UserStore(makeGatewayDbProvider(file)).getUserId();
    expect(a).toBe(b);
  });

  it('round-trips prefs through JSON encoding', () => {
    const s = newStore();
    s.setPrefs({ theme: 'dark', bgL: 5, accent: { hex: '#4950F6' } });
    const out = s.getAllPrefs();
    expect(out.theme).toBe('dark');
    expect(out.bgL).toBe(5);
    expect(out.accent).toEqual({ hex: '#4950F6' });
  });

  it('treats null/undefined as a delete', () => {
    const s = newStore();
    s.setPrefs({ theme: 'dark', density: 'comfy' });
    s.setPrefs({ theme: null });
    const out = s.getAllPrefs();
    expect(out.theme).toBe(undefined);
    expect(out.density).toBe('comfy');
  });

  it('overwrites existing values', () => {
    const s = newStore();
    s.setPrefs({ theme: 'dark' });
    s.setPrefs({ theme: 'light' });
    expect(s.getAllPrefs().theme).toBe('light');
  });

  it('returns empty object before any prefs are set', () => {
    const s = newStore();
    expect(s.getAllPrefs()).toEqual({});
  });
});

/* ---------- HTTP route handler ---------- */

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function mockRes(): { res: ServerResponse; data: MockRes } {
  const data: MockRes = { statusCode: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      data.statusCode = status;
      data.headers = headers;
    },
    end(body: string) {
      data.body = body;
    },
  } as unknown as ServerResponse;
  return { res, data };
}

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const text = body == null ? '' : JSON.stringify(body);
  const chunks = text ? [Buffer.from(text)] : [];
  const req = {
    method,
    url,
    headers: {},
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: () =>
          Promise.resolve(
            i < chunks.length
              ? { value: chunks[i++], done: false }
              : { value: undefined, done: true },
          ),
      };
    },
  } as unknown as IncomingMessage;
  return req;
}

describe('makeUserStoreRouteHandler', () => {
  it('returns false for non-matching prefixes', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res } = mockRes();
    const req = mockReq('GET', '/something-else');
    expect(await handler(req, res)).toBe(false);
  });

  it('GET /id returns the UUID', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res, data } = mockRes();
    await handler(mockReq('GET', '/_centraid-user/id'), res);
    expect(data.statusCode).toBe(200);
    const body = JSON.parse(data.body) as { id: string };
    expect(body.id).toBe(s.getUserId());
  });

  it('GET /prefs returns empty object initially', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res, data } = mockRes();
    await handler(mockReq('GET', '/_centraid-user/prefs'), res);
    expect(data.statusCode).toBe(200);
    expect(JSON.parse(data.body)).toEqual({ prefs: {} });
  });

  it('PUT /prefs merges and returns the new state', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    s.setPrefs({ theme: 'dark' });
    const { res, data } = mockRes();
    await handler(mockReq('PUT', '/_centraid-user/prefs', { patch: { density: 'comfy' } }), res);
    expect(data.statusCode).toBe(200);
    const body = JSON.parse(data.body) as { prefs: Record<string, unknown> };
    expect(body.prefs).toEqual({ theme: 'dark', density: 'comfy' });
  });

  it('PUT /prefs requires a patch object', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res, data } = mockRes();
    await handler(mockReq('PUT', '/_centraid-user/prefs', {}), res);
    expect(data.statusCode).toBe(400);
  });

  it('rejects unknown subroutes with 404', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res, data } = mockRes();
    await handler(mockReq('GET', '/_centraid-user/unknown'), res);
    expect(data.statusCode).toBe(404);
  });

  it('rejects wrong method with 405', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res, data } = mockRes();
    await handler(mockReq('DELETE', '/_centraid-user/prefs'), res);
    expect(data.statusCode).toBe(405);
  });
});
