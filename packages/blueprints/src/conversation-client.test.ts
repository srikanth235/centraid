/* oxlint-disable typescript-eslint/ban-ts-comment -- imports the untyped browser
   kit module (plain JS); the package tsconfig has no DOM lib (Response is a web
   global), so suppressing per-file matches kit-smoke.test.ts. */
// @ts-nocheck — exercises the untyped browser kit module (plain JS) directly.
// Unit tests for the shared conversation-client wire contract (issue #420) —
// the ONE place chat routes + model-picker state shape are defined.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG = path.resolve(import.meta.dirname, '..');
const url = pathToFileURL(path.resolve(PKG, 'kit/conversation-client.js')).href;
const {
  conversationsPath,
  conversationPath,
  conversationStatusPath,
  blobsPath,
  appTurnPath,
  appModelPath,
  assistantTurnPath,
  resolvePath,
  parkedListPath,
  parkedDecisionPath,
  vaultStatusPath,
  vaultAppsPath,
  normalizeModelState,
  modelLabel,
  readJsonResponse,
} = await import(url);

describe('route builders', () => {
  it('build the conversation / turn / vault routes, encoding ids', () => {
    expect(conversationsPath('todo')).toBe('/_centraid-conversations/apps/todo/sessions');
    expect(conversationPath('todo', 'a/b')).toBe(
      '/_centraid-conversations/apps/todo/sessions/a%2Fb',
    );
    expect(blobsPath('todo')).toBe('/_centraid-conversations/apps/todo/blobs');
    expect(appTurnPath('todo')).toBe('/centraid/todo/_turn');
    expect(appModelPath('todo')).toBe('/centraid/todo/_turn/model');
    expect(assistantTurnPath()).toBe('/centraid/_vault/assistant/_turn');
    expect(resolvePath()).toBe('/centraid/_vault/assistant/resolve');
    expect(parkedListPath()).toBe('/centraid/_vault/parked');
    expect(parkedDecisionPath('inv 1')).toBe('/centraid/_vault/parked/inv%201');
    expect(vaultStatusPath()).toBe('/centraid/_vault/status');
    expect(vaultAppsPath()).toBe('/centraid/_vault/apps');
    // Turn-settle poll for reconnect catch-up (#420).
    expect(conversationStatusPath('todo', 'abc')).toBe(
      '/_centraid-conversations/apps/todo/sessions/abc/status',
    );
  });

  it('treats a null/empty app id as an empty segment (bare preview)', () => {
    expect(conversationsPath(null)).toBe('/_centraid-conversations/apps//sessions');
  });
});

describe('model-picker state', () => {
  it('normalizes a model response body', () => {
    expect(
      normalizeModelState({ current: 'm1', defaultModel: 'default-x', catalog: [{ id: 'm1' }] }),
    ).toEqual({ loaded: true, current: 'm1', defaultModel: 'default-x', catalog: [{ id: 'm1' }] });
    expect(normalizeModelState(null)).toEqual({
      loaded: true,
      current: null,
      defaultModel: '',
      catalog: [],
    });
  });

  it('labels the current override, its catalog name, or "Default"', () => {
    expect(modelLabel({ loaded: false })).toBe('Model');
    expect(modelLabel({ loaded: true, current: null, catalog: [] })).toBe('Default');
    expect(
      modelLabel({ loaded: true, current: 'm1', catalog: [{ id: 'm1', label: 'Sonnet' }] }),
    ).toBe('Sonnet');
    expect(modelLabel({ loaded: true, current: 'm9', catalog: [] })).toBe('m9');
  });
});

describe('readJsonResponse', () => {
  it('reads a JSON body, tolerating empty/non-JSON payloads', async () => {
    const ok = new Response('{"a":1}', { status: 200 });
    expect(await readJsonResponse(ok)).toEqual({ ok: true, status: 200, body: { a: 1 } });
    const empty = new Response('', { status: 200 });
    expect(await readJsonResponse(empty)).toEqual({ ok: true, status: 200, body: null });
    const junk = new Response('not json', { status: 500 });
    expect(await readJsonResponse(junk)).toEqual({ ok: false, status: 500, body: null });
  });
});
