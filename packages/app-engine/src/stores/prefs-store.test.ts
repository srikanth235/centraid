import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PrefsStore, makeUserStoreRouteHandler } from './prefs-store.js';

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'centraid-prefs-')), 'prefs.json');
}

/** A minimal async-iterable IncomingMessage carrying an optional JSON body. */
function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  async function* gen(): AsyncGenerator<Buffer> {
    for (const c of chunks) yield c;
  }
  const req = gen() as unknown as IncomingMessage & { url: string; method: string };
  req.url = url;
  req.method = method;
  return req;
}

interface CapturedRes {
  statusCode: number;
  headers: Record<string, string>;
  json: unknown;
}
function mockRes(): { res: ServerResponse; out: CapturedRes } {
  const out: CapturedRes = { statusCode: 0, headers: {}, json: undefined };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.statusCode = status;
      out.headers = headers;
      return this;
    },
    end(text?: string) {
      out.json = text ? JSON.parse(text) : undefined;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

describe('PrefsStore', () => {
  it('starts empty on a missing file', () => {
    expect(new PrefsStore(freshFile()).getAllPrefs()).toEqual({});
  });

  it('starts empty when the file holds a non-object (defensive)', () => {
    const f = freshFile();
    writeFileSync(f, JSON.stringify(['not', 'an', 'object']));
    expect(new PrefsStore(f).getAllPrefs()).toEqual({});
  });

  it('starts empty when the file is unreadable JSON', () => {
    const f = freshFile();
    writeFileSync(f, '{ not json');
    expect(new PrefsStore(f).getAllPrefs()).toEqual({});
  });

  it('merges a patch and persists atomically (survives a reload)', () => {
    const f = freshFile();
    const store = new PrefsStore(f);
    const after = store.setPrefs({ runner: 'codex', theme: 'night' });
    expect(after).toEqual({ runner: 'codex', theme: 'night' });
    // A fresh instance reads the same bytes off disk (tmp + rename landed).
    expect(new PrefsStore(f).getAllPrefs()).toEqual({ runner: 'codex', theme: 'night' });
    // getAllPrefs returns a defensive copy, not the live cache.
    const copy = store.getAllPrefs();
    copy.runner = 'mutated';
    expect(store.getAllPrefs().runner).toBe('codex');
  });

  it('treats null / undefined values as key deletions', () => {
    const f = freshFile();
    const store = new PrefsStore(f);
    store.setPrefs({ a: 1, b: 2, c: 3 });
    const after = store.setPrefs({ a: null, b: undefined });
    expect(after).toEqual({ c: 3 });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ c: 3 });
  });

  it('an empty patch is a no-op that still returns the current prefs', () => {
    const store = new PrefsStore(freshFile());
    store.setPrefs({ x: 1 });
    expect(store.setPrefs({})).toEqual({ x: 1 });
  });
});

describe('makeUserStoreRouteHandler', () => {
  const handlerFor = (ownerId?: () => string) => {
    const store = new PrefsStore(freshFile());
    return { handler: makeUserStoreRouteHandler(() => store, ownerId), store };
  };

  it('ignores routes outside the /_centraid-user prefix', async () => {
    const { handler } = handlerFor();
    const { res, out } = mockRes();
    expect(await handler(mockReq('GET', '/centraid/other'), res)).toBe(false);
    expect(out.statusCode).toBe(0);
  });

  it('GET /id returns the owner id when a provider is wired', async () => {
    const { handler } = handlerFor(() => 'party-42');
    const { res, out } = mockRes();
    expect(await handler(mockReq('GET', '/_centraid-user/id'), res)).toBe(true);
    expect(out.statusCode).toBe(200);
    expect(out.json).toEqual({ id: 'party-42' });
  });

  it('GET /id 404s when no vault/owner provider is wired', async () => {
    const { handler } = handlerFor();
    const { res, out } = mockRes();
    await handler(mockReq('GET', '/_centraid-user/id'), res);
    expect(out.statusCode).toBe(404);
  });

  it('rejects a non-GET on /id', async () => {
    const { handler } = handlerFor(() => 'x');
    const { res, out } = mockRes();
    await handler(mockReq('POST', '/_centraid-user/id'), res);
    expect(out.statusCode).toBe(405);
  });

  it('GET then PUT /prefs round-trips a patch', async () => {
    const { handler } = handlerFor();
    let cap = mockRes();
    await handler(mockReq('GET', '/_centraid-user/prefs'), cap.res);
    expect(cap.out.json).toEqual({ prefs: {} });

    cap = mockRes();
    await handler(mockReq('PUT', '/_centraid-user/prefs', { patch: { theme: 'paper' } }), cap.res);
    expect(cap.out.statusCode).toBe(200);
    expect(cap.out.json).toEqual({ prefs: { theme: 'paper' } });
  });

  it('PUT /prefs 400s without a patch object', async () => {
    const { handler } = handlerFor();
    const { res, out } = mockRes();
    await handler(mockReq('PUT', '/_centraid-user/prefs', { nope: true }), res);
    expect(out.statusCode).toBe(400);
  });

  it('rejects an unsupported method on /prefs', async () => {
    const { handler } = handlerFor();
    const { res, out } = mockRes();
    await handler(mockReq('DELETE', '/_centraid-user/prefs'), res);
    expect(out.statusCode).toBe(405);
  });

  it('404s an unknown sub-route under the prefix', async () => {
    const { handler } = handlerFor();
    const { res, out } = mockRes();
    await handler(mockReq('GET', '/_centraid-user/bogus'), res);
    expect(out.statusCode).toBe(404);
  });
});
