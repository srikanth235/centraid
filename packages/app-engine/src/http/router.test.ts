import { describe, expect, it } from 'vitest';
import { parseRoute, parseWithDraft } from './router.js';

describe('parseRoute — app RPC routes (issue #505)', () => {
  it('parses POST /centraid/<id>/actions/<action>', () => {
    const r = parseRoute('POST', '/centraid/todos/actions/add');
    expect(r.kind).toBe('app-action');
    if (r.kind === 'app-action') {
      expect(r.appId).toBe('todos');
      expect(r.action).toBe('add');
    }
  });

  it('parses POST /centraid/<id>/queries/<query>', () => {
    const r = parseRoute('POST', '/centraid/todos/queries/upcoming');
    expect(r.kind).toBe('app-query');
    if (r.kind === 'app-query') {
      expect(r.appId).toBe('todos');
      expect(r.query).toBe('upcoming');
    }
  });

  it('decodes percent-encoded handler names', () => {
    const r = parseRoute('POST', '/centraid/todos/actions/add%2Ditem');
    expect(r.kind).toBe('app-action');
    if (r.kind === 'app-action') expect(r.action).toBe('add-item');
  });

  it('parses GET /centraid/<id>/_describe with an optional filter', () => {
    const bare = parseRoute('GET', '/centraid/todos/_describe');
    expect(bare.kind).toBe('app-describe');
    if (bare.kind === 'app-describe') expect(bare.query).toEqual({});
    const filtered = parseRoute('GET', '/centraid/todos/_describe?action=add');
    expect(filtered.kind).toBe('app-describe');
    if (filtered.kind === 'app-describe') expect(filtered.query).toEqual({ action: 'add' });
  });

  it('rejects non-POST action/query invocation', () => {
    // A GET under actions/queries falls through to static serving, not RPC.
    expect(parseRoute('GET', '/centraid/todos/queries/upcoming').kind).toBe('app-static');
    expect(parseRoute('PUT', '/centraid/todos/actions/add').kind).toBe('not-found');
  });

  it('rejects a bare or over-deep action/query path', () => {
    expect(parseRoute('POST', '/centraid/todos/actions').kind).toBe('not-found');
    expect(parseRoute('POST', '/centraid/todos/actions/add/extra').kind).toBe('not-found');
  });

  it('rejects non-GET /_describe', () => {
    expect(parseRoute('POST', '/centraid/todos/_describe').kind).toBe('not-found');
  });
});

describe('parseRoute — old per-app routes are gone (issue #107)', () => {
  it('GET /centraid/<id>/_data/<name> no longer dispatches', () => {
    // It falls through to app-static, which then 404s when the file
    // doesn't exist. The substantive guarantee is that the response is
    // not "execute a handler" — the route kind is not `app-data`.
    const r = parseRoute('GET', '/centraid/todos/_data/list');
    expect(r.kind).not.toBe('app-data' as never);
  });

  it('POST /centraid/<id>/_run no longer dispatches', () => {
    const r = parseRoute('POST', '/centraid/todos/_run');
    expect(r.kind).not.toBe('app-run' as never);
    // It also can't fall through to app-static because that's GET-only.
    expect(r.kind).toBe('not-found');
  });
});

describe('parseRoute — unaffected routes still work', () => {
  it('parses the query-only browser module route', () => {
    const r = parseRoute('GET', '/centraid/todos/_query/upcoming.mjs');
    expect(r).toEqual({
      kind: 'app-query-bundle',
      appId: 'todos',
      queryName: 'upcoming',
    });
  });

  it('never falls malformed query-module routes through to static serving', () => {
    expect(parseRoute('GET', '/centraid/todos/_query/upcoming.js').kind).toBe('not-found');
    expect(parseRoute('POST', '/centraid/todos/_query/upcoming.mjs').kind).toBe('not-found');
    expect(parseRoute('GET', '/centraid/todos/_query/a/b.mjs').kind).toBe('not-found');
  });

  it('parses /_changes', () => {
    const r = parseRoute('GET', '/centraid/todos/_changes');
    expect(r.kind).toBe('app-changes');
  });

  it('parses /_turn', () => {
    const r = parseRoute('POST', '/centraid/todos/_turn');
    expect(r.kind).toBe('app-chat');
  });

  it('parses static asset', () => {
    const r = parseRoute('GET', '/centraid/todos/app.css');
    expect(r.kind).toBe('app-static');
  });

  it('parses index', () => {
    const r = parseRoute('GET', '/centraid/todos');
    expect(r.kind).toBe('app-index');
  });
});

describe('parseWithDraft — draft-preview prefix (issue #141)', () => {
  it('passes a non-draft URL through unchanged with no session id', () => {
    const { route, draftSessionId } = parseWithDraft('GET', '/centraid/todos/');
    expect(draftSessionId).toBe(undefined);
    expect(route.kind).toBe('app-index');
  });

  it('peels the draft prefix off an index request', () => {
    const { route, draftSessionId } = parseWithDraft('GET', '/centraid/_draft/s1/todos/');
    expect(draftSessionId).toBe('s1');
    expect(route.kind).toBe('app-index');
    expect((route as { appId: string }).appId).toBe('todos');
  });

  it('peels the draft prefix off a static asset request', () => {
    const { route, draftSessionId } = parseWithDraft('GET', '/centraid/_draft/s1/todos/app.css');
    expect(draftSessionId).toBe('s1');
    expect(route.kind).toBe('app-static');
    expect((route as { rel: string }).rel).toBe('app.css');
  });

  it('peels the draft prefix off a query bundle request', () => {
    const { route, draftSessionId } = parseWithDraft(
      'GET',
      '/centraid/_draft/s1/todos/_query/upcoming.mjs',
    );
    expect(draftSessionId).toBe('s1');
    expect(route).toEqual({
      kind: 'app-query-bundle',
      appId: 'todos',
      queryName: 'upcoming',
    });
  });

  it('peels the draft prefix off an app query invocation and preserves the inner shape', () => {
    const { route, draftSessionId } = parseWithDraft(
      'POST',
      '/centraid/_draft/s1/todos/queries/upcoming',
    );
    expect(draftSessionId).toBe('s1');
    expect(route.kind).toBe('app-query');
    expect((route as { appId: string }).appId).toBe('todos');
    expect((route as { query: string }).query).toBe('upcoming');
  });

  it('preserves the query string when rewriting', () => {
    const { route } = parseWithDraft('GET', '/centraid/_draft/s1/todos?theme=dark');
    expect(route.kind).toBe('app-index');
    expect((route as { query: Record<string, string> }).query).toEqual({ theme: 'dark' });
  });

  it('a draft prefix with no session id is not-found', () => {
    const { route } = parseWithDraft('GET', '/centraid/_draft/');
    expect(route.kind).toBe('not-found');
  });
});
