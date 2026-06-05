import { describe, expect, it } from 'vitest';
import { parseRoute, parseWithDraft } from './router.js';

describe('parseRoute — tool-invoke shim (issue #107)', () => {
  it('parses POST /centraid/_tool/centraid_write', () => {
    const r = parseRoute('POST', '/centraid/_tool/centraid_write');
    expect(r.kind).toBe('tool-invoke');
    if (r.kind === 'tool-invoke') expect(r.toolName).toBe('centraid_write');
  });

  it('parses POST /centraid/_tool/centraid_read', () => {
    const r = parseRoute('POST', '/centraid/_tool/centraid_read');
    expect(r.kind).toBe('tool-invoke');
    if (r.kind === 'tool-invoke') expect(r.toolName).toBe('centraid_read');
  });

  it('parses POST /centraid/_tool/centraid_describe', () => {
    const r = parseRoute('POST', '/centraid/_tool/centraid_describe');
    expect(r.kind).toBe('tool-invoke');
    if (r.kind === 'tool-invoke') expect(r.toolName).toBe('centraid_describe');
  });

  it('does not require centraid_ prefix at the router level (validation happens in dispatcher)', () => {
    // The router accepts any non-empty tool name; the dispatcher's
    // isToolName guard catches unknown tools and returns 404. Keeps the
    // router's grammar trivial.
    const r = parseRoute('POST', '/centraid/_tool/anything');
    expect(r.kind).toBe('tool-invoke');
    if (r.kind === 'tool-invoke') expect(r.toolName).toBe('anything');
  });

  it('rejects non-POST /centraid/_tool/<name>', () => {
    expect(parseRoute('GET', '/centraid/_tool/centraid_read').kind).toBe('not-found');
    expect(parseRoute('PUT', '/centraid/_tool/centraid_write').kind).toBe('not-found');
  });

  it('rejects bare /centraid/_tool', () => {
    expect(parseRoute('POST', '/centraid/_tool').kind).toBe('not-found');
    expect(parseRoute('POST', '/centraid/_tool/').kind).toBe('not-found');
  });

  it('rejects extra path segments', () => {
    expect(parseRoute('POST', '/centraid/_tool/centraid_read/extra').kind).toBe('not-found');
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

  it('peels the draft prefix off a tool-invoke and preserves the inner shape', () => {
    const { route, draftSessionId } = parseWithDraft(
      'POST',
      '/centraid/_draft/s1/_tool/centraid_read',
    );
    expect(draftSessionId).toBe('s1');
    expect(route.kind).toBe('tool-invoke');
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
