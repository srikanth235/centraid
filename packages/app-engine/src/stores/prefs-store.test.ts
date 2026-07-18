import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PrefsStore,
  makeUserStoreRouteHandler,
  resolveSubsystemModel,
  resolveSubsystemRunner,
} from './prefs-store.js';

function freshFile(): string {
  return join(tempDirSync('centraid-prefs-'), 'prefs.json');
}

/** A minimal async-iterable IncomingMessage carrying an optional JSON body. */
function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks) as unknown as IncomingMessage & { url: string; method: string };
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

describe('resolveSubsystemModel', () => {
  it('prefers the explicit override over any pref', () => {
    const prefs = {
      'model.claude-code.assistant': 'from-subsystem-pref',
      'model.claude-code.default': 'from-default-pref',
    };
    expect(resolveSubsystemModel(prefs, 'claude-code', 'assistant', 'explicit-model')).toBe(
      'explicit-model',
    );
  });

  it('falls through to the per-subsystem pref when there is no explicit value', () => {
    const prefs = {
      'model.claude-code.assistant': 'from-subsystem-pref',
      'model.claude-code.default': 'from-default-pref',
    };
    expect(resolveSubsystemModel(prefs, 'claude-code', 'assistant')).toBe('from-subsystem-pref');
  });

  it('falls through to the runner-wide default when the subsystem pref is unset', () => {
    const prefs = { 'model.claude-code.default': 'from-default-pref' };
    expect(resolveSubsystemModel(prefs, 'claude-code', 'assistant')).toBe('from-default-pref');
  });

  it('treats an empty-string pref as unset and keeps falling through', () => {
    const prefs = {
      'model.claude-code.assistant': '',
      'model.claude-code.default': 'from-default-pref',
    };
    expect(resolveSubsystemModel(prefs, 'claude-code', 'assistant')).toBe('from-default-pref');
  });

  it('resolves to undefined when nothing is configured — the backend uses its own default', () => {
    expect(resolveSubsystemModel({}, 'claude-code', 'assistant')).toBeUndefined();
  });

  it('scopes prefs by runner kind — a codex pref does not leak into claude-code resolution', () => {
    const prefs = { 'model.codex.assistant': 'codex-only-model' };
    expect(resolveSubsystemModel(prefs, 'claude-code', 'assistant')).toBeUndefined();
  });

  it('scopes prefs by subsystem — an ask override does not leak into builder resolution', () => {
    const prefs = { 'model.codex.ask': 'ask-only-model' };
    expect(resolveSubsystemModel(prefs, 'codex', 'builder')).toBeUndefined();
  });

  it('ignores an empty-string explicit override (falls through like unset)', () => {
    const prefs = { 'model.codex.automations': 'automations-model' };
    expect(resolveSubsystemModel(prefs, 'codex', 'automations', '')).toBe('automations-model');
  });
});

describe('resolveSubsystemRunner', () => {
  it('prefers the per-subsystem pin over the default agent', () => {
    const prefs = { 'runner.assistant': 'claude-code', 'agent.runner.kind': 'codex' };
    expect(resolveSubsystemRunner(prefs, 'assistant')).toBe('claude-code');
  });

  it('falls back to the default agent when the subsystem is unpinned', () => {
    const prefs = { 'agent.runner.kind': 'claude-code' };
    expect(resolveSubsystemRunner(prefs, 'assistant')).toBe('claude-code');
  });

  it("falls back to 'codex' when nothing is configured at all", () => {
    expect(resolveSubsystemRunner({}, 'assistant')).toBe('codex');
  });

  it('scopes pins by subsystem — an ask pin does not leak into builder resolution', () => {
    const prefs = { 'runner.ask': 'claude-code', 'agent.runner.kind': 'codex' };
    expect(resolveSubsystemRunner(prefs, 'ask')).toBe('claude-code');
    // Every other subsystem still inherits the default agent.
    expect(resolveSubsystemRunner(prefs, 'builder')).toBe('codex');
    expect(resolveSubsystemRunner(prefs, 'assistant')).toBe('codex');
    expect(resolveSubsystemRunner(prefs, 'automations')).toBe('codex');
  });

  it('treats an empty-string pin as unset and keeps falling through', () => {
    const prefs = { 'runner.builder': '', 'agent.runner.kind': 'claude-code' };
    expect(resolveSubsystemRunner(prefs, 'builder')).toBe('claude-code');
    // ...all the way to the built-in default when there's no default agent either.
    expect(resolveSubsystemRunner({ 'runner.builder': '' }, 'builder')).toBe('codex');
  });

  it('treats an empty-string default agent as unset (falls through to codex)', () => {
    expect(resolveSubsystemRunner({ 'agent.runner.kind': '' }, 'automations')).toBe('codex');
  });

  it('each subsystem can pin a different runner independently', () => {
    const prefs = {
      'runner.assistant': 'claude-code',
      'runner.automations': 'codex',
      'agent.runner.kind': 'claude-code',
    };
    expect(resolveSubsystemRunner(prefs, 'assistant')).toBe('claude-code');
    expect(resolveSubsystemRunner(prefs, 'automations')).toBe('codex');
    // Unpinned subsystems still inherit the default agent.
    expect(resolveSubsystemRunner(prefs, 'ask')).toBe('claude-code');
  });

  it('is byte-identical to the old global behavior when no runner.* key is set', () => {
    // Back-compat is the hard requirement: with only `agent.runner.kind`
    // present, EVERY subsystem resolves to it — exactly what the single
    // global active runner did before per-subsystem selection existed.
    for (const kind of ['codex', 'claude-code'] as const) {
      const prefs = { 'agent.runner.kind': kind };
      for (const s of ['assistant', 'ask', 'builder', 'automations'] as const) {
        expect(resolveSubsystemRunner(prefs, s)).toBe(kind);
      }
    }
  });
});

/**
 * The two resolvers compose the way the gateway's `resolveModel` uses them:
 * resolve the RUNNER for the subsystem first, then scope the model key by
 * THAT kind. Reading the model against the global kind instead is the bug
 * this pairing exists to prevent.
 */
describe('resolveSubsystemRunner + resolveSubsystemModel compose', () => {
  it("reads the model key of the subsystem's OWN runner, not the default agent's", () => {
    const prefs = {
      'agent.runner.kind': 'codex',
      'runner.ask': 'claude-code',
      'model.codex.ask': 'codex-ask-model',
      'model.claude-code.ask': 'claude-ask-model',
    };
    const kind = resolveSubsystemRunner(prefs, 'ask');
    expect(kind).toBe('claude-code');
    expect(resolveSubsystemModel(prefs, kind, 'ask')).toBe('claude-ask-model');
    // The builder, still unpinned, keeps reading the default agent's keys.
    expect(resolveSubsystemModel(prefs, resolveSubsystemRunner(prefs, 'builder'), 'ask')).toBe(
      'codex-ask-model',
    );
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
