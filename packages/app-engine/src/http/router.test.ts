import { describe, it } from 'vitest';
import { strict as assert } from 'node:assert';
import { parseRoute, parseWithDraft } from './router.js';

describe('parseRoute — tool-invoke shim (issue #107)', () => {
  it('parses POST /centraid/_tool/centraid_write', () => {
    const r = parseRoute('POST', '/centraid/_tool/centraid_write');
    assert.equal(r.kind, 'tool-invoke');
    if (r.kind === 'tool-invoke') assert.equal(r.toolName, 'centraid_write');
  });

  it('parses POST /centraid/_tool/centraid_read', () => {
    const r = parseRoute('POST', '/centraid/_tool/centraid_read');
    assert.equal(r.kind, 'tool-invoke');
    if (r.kind === 'tool-invoke') assert.equal(r.toolName, 'centraid_read');
  });

  it('parses POST /centraid/_tool/centraid_describe', () => {
    const r = parseRoute('POST', '/centraid/_tool/centraid_describe');
    assert.equal(r.kind, 'tool-invoke');
    if (r.kind === 'tool-invoke') assert.equal(r.toolName, 'centraid_describe');
  });

  it('does not require centraid_ prefix at the router level (validation happens in dispatcher)', () => {
    // The router accepts any non-empty tool name; the dispatcher's
    // isToolName guard catches unknown tools and returns 404. Keeps the
    // router's grammar trivial.
    const r = parseRoute('POST', '/centraid/_tool/anything');
    assert.equal(r.kind, 'tool-invoke');
    if (r.kind === 'tool-invoke') assert.equal(r.toolName, 'anything');
  });

  it('rejects non-POST /centraid/_tool/<name>', () => {
    assert.equal(parseRoute('GET', '/centraid/_tool/centraid_read').kind, 'not-found');
    assert.equal(parseRoute('PUT', '/centraid/_tool/centraid_write').kind, 'not-found');
  });

  it('rejects bare /centraid/_tool', () => {
    assert.equal(parseRoute('POST', '/centraid/_tool').kind, 'not-found');
    assert.equal(parseRoute('POST', '/centraid/_tool/').kind, 'not-found');
  });

  it('rejects extra path segments', () => {
    assert.equal(parseRoute('POST', '/centraid/_tool/centraid_read/extra').kind, 'not-found');
  });
});

describe('parseRoute — old per-app routes are gone (issue #107)', () => {
  it('GET /centraid/<id>/_data/<name> no longer dispatches', () => {
    // It falls through to app-static, which then 404s when the file
    // doesn't exist. The substantive guarantee is that the response is
    // not "execute a handler" — the route kind is not `app-data`.
    const r = parseRoute('GET', '/centraid/todos/_data/list');
    assert.notEqual(r.kind, 'app-data' as never);
  });

  it('POST /centraid/<id>/_run no longer dispatches', () => {
    const r = parseRoute('POST', '/centraid/todos/_run');
    assert.notEqual(r.kind, 'app-run' as never);
    // It also can't fall through to app-static because that's GET-only.
    assert.equal(r.kind, 'not-found');
  });
});

describe('parseRoute — unaffected routes still work', () => {
  it('parses /_changes', () => {
    const r = parseRoute('GET', '/centraid/todos/_changes');
    assert.equal(r.kind, 'app-changes');
  });

  it('parses /_turn', () => {
    const r = parseRoute('POST', '/centraid/todos/_turn');
    assert.equal(r.kind, 'app-chat');
  });

  it('parses static asset', () => {
    const r = parseRoute('GET', '/centraid/todos/app.css');
    assert.equal(r.kind, 'app-static');
  });

  it('parses index', () => {
    const r = parseRoute('GET', '/centraid/todos');
    assert.equal(r.kind, 'app-index');
  });
});

describe('parseWithDraft — draft-preview prefix (issue #141)', () => {
  it('passes a non-draft URL through unchanged with no session id', () => {
    const { route, draftSessionId } = parseWithDraft('GET', '/centraid/todos/');
    assert.equal(draftSessionId, undefined);
    assert.equal(route.kind, 'app-index');
  });

  it('peels the draft prefix off an index request', () => {
    const { route, draftSessionId } = parseWithDraft('GET', '/centraid/_draft/s1/todos/');
    assert.equal(draftSessionId, 's1');
    assert.equal(route.kind, 'app-index');
    assert.equal((route as { appId: string }).appId, 'todos');
  });

  it('peels the draft prefix off a static asset request', () => {
    const { route, draftSessionId } = parseWithDraft('GET', '/centraid/_draft/s1/todos/app.css');
    assert.equal(draftSessionId, 's1');
    assert.equal(route.kind, 'app-static');
    assert.equal((route as { rel: string }).rel, 'app.css');
  });

  it('peels the draft prefix off a tool-invoke and preserves the inner shape', () => {
    const { route, draftSessionId } = parseWithDraft(
      'POST',
      '/centraid/_draft/s1/_tool/centraid_read',
    );
    assert.equal(draftSessionId, 's1');
    assert.equal(route.kind, 'tool-invoke');
  });

  it('preserves the query string when rewriting', () => {
    const { route } = parseWithDraft('GET', '/centraid/_draft/s1/todos?theme=dark');
    assert.equal(route.kind, 'app-index');
    assert.deepEqual((route as { query: Record<string, string> }).query, { theme: 'dark' });
  });

  it('a draft prefix with no session id is not-found', () => {
    const { route } = parseWithDraft('GET', '/centraid/_draft/');
    assert.equal(route.kind, 'not-found');
  });
});
