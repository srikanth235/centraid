import { tempDir } from '@centraid/test-kit/temp-dir';
import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Runtime } from '../runtime.js';
import {
  clearQueryBundleCaches,
  QUERY_NAME_HEADER,
  QUERY_SOURCE_HASH_HEADER,
} from './query-bundle.js';

const manifest = {
  manifestVersion: 1,
  id: 'demo',
  name: 'Demo',
  version: '0.1.0',
  actions: [
    {
      name: 'mutate',
      confirmation: 'none',
      input: { type: 'object', properties: {}, additionalProperties: false },
      writes: [],
    },
  ],
  queries: ['list', 'leak', 'broken', 'typed'].map((name) => ({
    name,
    input: { type: 'object', properties: {}, additionalProperties: false },
  })),
};

let workspace: string;
let liveDir: string;
let draftDir: string;
let runtime: Runtime;

async function writeCodeDir(directory: string, value: string): Promise<void> {
  await fs.mkdir(path.join(directory, 'queries'), { recursive: true });
  await fs.mkdir(path.join(directory, 'actions'), { recursive: true });
  await fs.writeFile(path.join(directory, 'app.json'), JSON.stringify(manifest));
  await fs.writeFile(
    path.join(directory, 'queries', 'helper.js'),
    `export const value = ${JSON.stringify(value)};`,
  );
  await fs.writeFile(
    path.join(directory, 'queries', 'list.js'),
    `import { value } from './helper.js'; export default async () => ({ value });`,
  );
  await fs.writeFile(
    path.join(directory, 'queries', 'leak.js'),
    `import secret from '../actions/mutate.js'; export default async () => secret;`,
  );
  await fs.writeFile(path.join(directory, 'queries', 'broken.js'), `export default async (`);
  // TS-authored query: a `.ts` entry importing a `.ts` sibling extensionlessly
  // (`./typed-helper` → typed-helper.ts). Exercises the `.ts`-first entry probe
  // and the `.ts` resolveQueryImport candidate.
  await fs.writeFile(
    path.join(directory, 'queries', 'typed-helper.ts'),
    `export function helper(v: string): string { return 'typed-' + v; }`,
  );
  await fs.writeFile(
    path.join(directory, 'queries', 'typed.ts'),
    `import { helper } from './typed-helper';\n` +
      `interface Out { value: string }\n` +
      `export default async (): Promise<Out> => ({ value: helper(${JSON.stringify(value)}) });`,
  );
  await fs.writeFile(
    path.join(directory, 'actions', 'mutate.js'),
    `const secret = 'ACTION_SECRET_MUST_NOT_BUNDLE'; export default secret;`,
  );
}

class MockResponse {
  statusCode = 200;
  readonly headers = new Headers();
  body = Buffer.alloc(0);
  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    return this;
  }
  end(value?: string | Buffer): this {
    this.body = value === undefined ? Buffer.alloc(0) : Buffer.from(value);
    return this;
  }
}

async function request(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init.headers).entries()) as IncomingHttpHeaders;
  const req = {
    method: init.method ?? 'GET',
    url: pathname,
    headers,
  } as IncomingMessage;
  const mock = new MockResponse();
  await runtime.handle(req, mock as unknown as ServerResponse);
  return new Response(mock.body.length === 0 ? null : mock.body, {
    status: mock.statusCode,
    headers: mock.headers,
  });
}

async function evaluateDefault(code: string, etag: string): Promise<unknown> {
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${encodeURIComponent(etag)}`;
  const module = (await import(url)) as { default: () => Promise<unknown> };
  return module.default();
}

beforeEach(async () => {
  clearQueryBundleCaches();
  workspace = await tempDir('centraid-query-bundle-');
  liveDir = path.join(workspace, 'live');
  draftDir = path.join(workspace, 'draft');
  await writeCodeDir(liveDir, 'live-v1');
  await writeCodeDir(draftDir, 'draft-v1');
  runtime = new Runtime({
    appsDir: path.join(workspace, 'state'),
    codeDirOverride: async (appId) => (appId === 'demo' ? liveDir : undefined),
    draftCodeDir: async (appId, sessionId) =>
      appId === 'demo' && sessionId === 'session-1' ? draftDir : undefined,
  });
  await runtime.bootstrap();
  await runtime.registry.ensureUploaded('demo');
});

afterEach(async () => {
  clearQueryBundleCaches();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('query-only browser bundles', () => {
  it('serves a directly importable declared query with its helper', async () => {
    const response = await request('/centraid/demo/_query/list.mjs');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/javascript/);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(response.headers.get(QUERY_NAME_HEADER)).toBe('list');
    expect(response.headers.get(QUERY_SOURCE_HASH_HEADER)).toMatch(/^[0-9a-f]{64}$/);
    expect(response.headers.get('access-control-expose-headers')).toContain(
      QUERY_SOURCE_HASH_HEADER,
    );
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    const code = await response.text();
    expect(code).toContain('live-v1');
    expect(code).not.toContain('ACTION_SECRET_MUST_NOT_BUNDLE');
    await expect(evaluateDefault(code, response.headers.get('etag')!)).resolves.toEqual({
      value: 'live-v1',
    });
  });

  it('bundles a TypeScript query entry with a .ts sibling import, stripping types', async () => {
    const response = await request('/centraid/demo/_query/typed.mjs');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/javascript/);
    expect(response.headers.get(QUERY_NAME_HEADER)).toBe('typed');
    const code = await response.text();
    // Type syntax is gone; the sibling helper's runtime code is bundled in.
    expect(code).not.toMatch(/interface\s+Out/);
    expect(code).not.toMatch(/:\s*string/);
    await expect(evaluateDefault(code, response.headers.get('etag')!)).resolves.toEqual({
      value: 'typed-live-v1',
    });
  });

  it('enforces an authenticated browser session app scope before resolving code', async () => {
    const response = await request('/centraid/demo/_query/list.mjs', {
      headers: { 'x-centraid-web-app': 'another-app' },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'app_session_scope' });
  });

  it('keeps action sources inaccessible and refuses query imports that leave queries/', async () => {
    const actionAsQuery = await request('/centraid/demo/_query/mutate.mjs');
    expect(actionAsQuery.status).toBe(404);
    await expect(actionAsQuery.json()).resolves.toMatchObject({ error: 'unknown_query' });

    expect((await request('/centraid/demo/actions/mutate.js')).status).toBe(404);
    expect((await request('/centraid/demo/queries/list.js')).status).toBe(404);

    const leakingQuery = await request('/centraid/demo/_query/leak.mjs');
    expect(leakingQuery.status).toBe(422);
    const failure = (await leakingQuery.json()) as { error: string; message: string };
    expect(failure.error).toBe('query_bundle_failed');
    expect(failure.message).toContain('escapes queries/');
    expect(failure.message).not.toContain('ACTION_SECRET_MUST_NOT_BUNDLE');
  });

  it('does not follow a queries-directory symlink onto action sources', async () => {
    const hostile = path.join(workspace, 'hostile');
    const actions = path.join(hostile, 'actions');
    await fs.mkdir(actions, { recursive: true });
    await fs.writeFile(path.join(hostile, 'app.json'), JSON.stringify(manifest));
    await fs.writeFile(
      path.join(actions, 'list.js'),
      `export default 'ACTION_SECRET_MUST_NOT_BUNDLE';`,
    );
    await fs.symlink(actions, path.join(hostile, 'queries'), 'dir');
    liveDir = hostile;

    const response = await request('/centraid/demo/_query/list.mjs');
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain('query_source_missing');
    expect(body).not.toContain('ACTION_SECRET_MUST_NOT_BUNDLE');
  });

  it('rejects undeclared and traversal-shaped query names with typed errors', async () => {
    const undeclared = await request('/centraid/demo/_query/not-declared.mjs');
    expect(undeclared.status).toBe(404);
    await expect(undeclared.json()).resolves.toMatchObject({ error: 'unknown_query' });

    const traversal = await request('/centraid/demo/_query/%2E%2E%2Faction%2Fmutate.mjs');
    expect(traversal.status).toBe(400);
    await expect(traversal.json()).resolves.toMatchObject({ error: 'invalid_query_name' });
  });

  it('returns stable hashes and ETags, 304s matches, and invalidates on source edits', async () => {
    const first = await request('/centraid/demo/_query/list.mjs');
    const firstEtag = first.headers.get('etag')!;
    const firstSourceHash = first.headers.get(QUERY_SOURCE_HASH_HEADER)!;
    await first.arrayBuffer();

    const revalidated = await request('/centraid/demo/_query/list.mjs', {
      headers: { 'If-None-Match': firstEtag },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');
    expect(revalidated.headers.get(QUERY_SOURCE_HASH_HEADER)).toBe(firstSourceHash);

    await fs.writeFile(
      path.join(liveDir, 'queries', 'helper.js'),
      `export const value = 'live-version-two';`,
    );
    const edited = await request('/centraid/demo/_query/list.mjs', {
      headers: { 'If-None-Match': firstEtag },
    });
    expect(edited.status).toBe(200);
    expect(edited.headers.get('etag')).not.toBe(firstEtag);
    expect(edited.headers.get(QUERY_SOURCE_HASH_HEADER)).not.toBe(firstSourceHash);
    const code = await edited.text();
    await expect(evaluateDefault(code, edited.headers.get('etag')!)).resolves.toEqual({
      value: 'live-version-two',
    });
  });

  it('resolves live and draft query graphs through their respective code directories', async () => {
    const live = await request('/centraid/demo/_query/list.mjs');
    const draft = await request('/centraid/_draft/session-1/demo/_query/list.mjs');
    expect(live.status).toBe(200);
    expect(draft.status).toBe(200);
    const liveCode = await live.text();
    const draftCode = await draft.text();
    await expect(evaluateDefault(liveCode, live.headers.get('etag')!)).resolves.toEqual({
      value: 'live-v1',
    });
    await expect(evaluateDefault(draftCode, draft.headers.get('etag')!)).resolves.toEqual({
      value: 'draft-v1',
    });
    expect(draft.headers.get(QUERY_SOURCE_HASH_HEADER)).not.toBe(
      live.headers.get(QUERY_SOURCE_HASH_HEADER),
    );
  });

  it('fails syntax errors as typed JSON without serving executable fallback code', async () => {
    const response = await request('/centraid/demo/_query/broken.mjs');
    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('query_bundle_failed');
    expect(body.message).toContain('broken.js');
  });
});
