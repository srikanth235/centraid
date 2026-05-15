import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UserStore, MIGRATIONS, makeUserStoreRouteHandler } from './user-store.js';
import { IncomingMessage, ServerResponse } from 'node:http';

function newStore(): UserStore {
  // Each test gets its own DB file so cases stay isolated.
  const dir = mkdtempSync(join(tmpdir(), 'centraid-user-store-'));
  return new UserStore(join(dir, 'db.sqlite'));
}

describe('UserStore', () => {
  it('returns the same UUID across calls', () => {
    const s = newStore();
    const a = s.getUserId();
    const b = s.getUserId();
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('persists the UUID across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'centraid-user-store-'));
    const file = join(dir, 'db.sqlite');
    const a = new UserStore(file).getUserId();
    const b = new UserStore(file).getUserId();
    assert.equal(a, b);
  });

  it('round-trips prefs through JSON encoding', () => {
    const s = newStore();
    s.setPrefs({ theme: 'dark', bgL: 5, accent: { hex: '#4950F6' } });
    const out = s.getAllPrefs();
    assert.equal(out.theme, 'dark');
    assert.equal(out.bgL, 5);
    assert.deepEqual(out.accent, { hex: '#4950F6' });
  });

  it('treats null/undefined as a delete', () => {
    const s = newStore();
    s.setPrefs({ theme: 'dark', density: 'comfy' });
    s.setPrefs({ theme: null });
    const out = s.getAllPrefs();
    assert.equal(out.theme, undefined);
    assert.equal(out.density, 'comfy');
  });

  it('overwrites existing values', () => {
    const s = newStore();
    s.setPrefs({ theme: 'dark' });
    s.setPrefs({ theme: 'light' });
    assert.equal(s.getAllPrefs().theme, 'light');
  });

  it('returns empty object before any prefs are set', () => {
    const s = newStore();
    assert.deepEqual(s.getAllPrefs(), {});
  });

  it('migrations array advances PRAGMA user_version', () => {
    // Sanity-check that migration count and the resulting user_version match —
    // catches accidental edits to shipped slots.
    const dir = mkdtempSync(join(tmpdir(), 'centraid-user-store-'));
    const file = join(dir, 'db.sqlite');
    const s = new UserStore(file);
    s.getUserId(); // force open
    const db = new DatabaseSync(file);
    const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
    db.close();
    assert.equal(v.user_version, MIGRATIONS.length);
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
    assert.equal(await handler(req, res), false);
  });

  it('GET /id returns the UUID', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res, data } = mockRes();
    await handler(mockReq('GET', '/_centraid-user/id'), res);
    assert.equal(data.statusCode, 200);
    const body = JSON.parse(data.body) as { id: string };
    assert.equal(body.id, s.getUserId());
  });

  it('GET /prefs returns empty object initially', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res, data } = mockRes();
    await handler(mockReq('GET', '/_centraid-user/prefs'), res);
    assert.equal(data.statusCode, 200);
    assert.deepEqual(JSON.parse(data.body), { prefs: {} });
  });

  it('PUT /prefs merges and returns the new state', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    s.setPrefs({ theme: 'dark' });
    const { res, data } = mockRes();
    await handler(mockReq('PUT', '/_centraid-user/prefs', { patch: { density: 'comfy' } }), res);
    assert.equal(data.statusCode, 200);
    const body = JSON.parse(data.body) as { prefs: Record<string, unknown> };
    assert.deepEqual(body.prefs, { theme: 'dark', density: 'comfy' });
  });

  it('PUT /prefs requires a patch object', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res, data } = mockRes();
    await handler(mockReq('PUT', '/_centraid-user/prefs', {}), res);
    assert.equal(data.statusCode, 400);
  });

  it('rejects unknown subroutes with 404', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res, data } = mockRes();
    await handler(mockReq('GET', '/_centraid-user/unknown'), res);
    assert.equal(data.statusCode, 404);
  });

  it('rejects wrong method with 405', async () => {
    const s = newStore();
    const handler = makeUserStoreRouteHandler(() => s);
    const { res, data } = mockRes();
    await handler(mockReq('DELETE', '/_centraid-user/prefs'), res);
    assert.equal(data.statusCode, 405);
  });
});
