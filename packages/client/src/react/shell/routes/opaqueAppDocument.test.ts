import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { prepareOpaqueAppDocument } from './opaqueAppDocument.js';

const appId = 'todos';
const bridge = 'd-device-a';

function virtual(path: string): string {
  return `${window.location.origin}/__centraid_iroh__/${bridge}${path}`;
}

function fakeResponse(options: {
  url: string;
  body: string | Uint8Array;
  contentType: string;
  status?: number;
}): Response {
  const bytes =
    typeof options.body === 'string' ? new TextEncoder().encode(options.body) : options.body;
  return {
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    status: options.status ?? 200,
    statusText: options.status === 404 ? 'Not Found' : 'OK',
    url: options.url,
    headers: new Headers({
      'content-type': options.contentType,
      'x-fixture': 'yes',
    }),
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.slice().buffer,
  } as Response;
}

function decodeDocument(url: string): string {
  const encoded = url.split(',', 2)[1];
  if (!encoded) throw new Error('missing data URL payload');
  const binary = atob(encoded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

beforeEach(() => {
  const meta = document.createElement('meta');
  meta.name = 'centraid-csp-nonce';
  meta.content = 'shell-nonce';
  document.head.append(meta);
});

afterEach(() => {
  document.querySelectorAll('meta[name="centraid-csp-nonce"]').forEach((meta) => meta.remove());
});

describe('prepareOpaqueAppDocument', () => {
  test('inlines the live bundle and stylesheet under the inherited shell nonce', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/_web/session')) {
        return fakeResponse({
          url: virtual('/centraid/todos/?theme=dark'),
          contentType: 'text/html',
          body: `<!doctype html><html><head>
            <link rel="stylesheet" href="app.css">
            <script type="module" src="bundle.js"></script>
          </head><body><main>Todo</main></body></html>`,
        });
      }
      if (new URL(url).pathname.endsWith('/app.css')) {
        return fakeResponse({ url, contentType: 'text/css', body: 'main{color:green}' });
      }
      return fakeResponse({
        url,
        contentType: 'text/javascript',
        body: 'window.__todoBooted = true;',
      });
    });

    const prepared = await prepareOpaqueAppDocument({
      appId,
      launchUrl: virtual('/centraid/_web/session?code=one'),
      documentNonce: 'document-one',
      fetch: fetcher as typeof window.fetch,
    });
    const html = decodeDocument(prepared.documentUrl);

    expect(html).toContain("script-src 'nonce-shell-nonce' blob:");
    expect(html).toContain('nonce="shell-nonce"');
    expect(html).toContain('<script type="module" nonce="shell-nonce">');
    expect(html).toContain('window.__todoBooted = true;');
    expect(html).toContain('<style>main{color:green}</style>');
    expect(html).not.toContain('src="bundle.js"');
    expect(html).not.toContain('href="app.css"');
    expect(html).toContain('opaqueBaseUrl');
    expect(html).toContain('document-one');
  });

  test('routes root-relative bytes through only the launch bridge scope', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/_web/session')) {
        return fakeResponse({
          url: virtual('/centraid/todos/'),
          contentType: 'text/html',
          body: '<!doctype html><html><head></head><body></body></html>',
        });
      }
      return fakeResponse({
        url,
        contentType: 'image/jpeg',
        body: new Uint8Array([1, 2, 3]),
      });
    });
    const prepared = await prepareOpaqueAppDocument({
      appId,
      launchUrl: virtual('/centraid/_web/session?code=one'),
      documentNonce: 'document-one',
      fetch: fetcher as typeof window.fetch,
    });

    const result = await prepared.fetchResource({
      url: `${window.location.origin}/centraid/_vault/blobs/sha-one`,
      method: 'GET',
      headers: [
        ['accept', 'image/jpeg'],
        ['authorization', 'must-not-forward'],
      ],
    });

    expect(calls.at(-1)?.url).toBe(virtual('/centraid/_vault/blobs/sha-one?__centraid_app=todos'));
    expect(new Headers(calls.at(-1)?.init?.headers).get('authorization')).toBeNull();
    expect([...new Uint8Array(result.body)]).toEqual([1, 2, 3]);
  });

  test('rejects a redirect or subresource that leaves the launch bridge', async () => {
    const launch = virtual('/centraid/_web/session?code=one');
    const escaped = `${window.location.origin}/__centraid_iroh__/d-other/centraid/todos/`;
    await expect(
      prepareOpaqueAppDocument({
        appId,
        launchUrl: launch,
        documentNonce: 'document-one',
        fetch: (async () =>
          fakeResponse({
            url: escaped,
            contentType: 'text/html',
            body: '<!doctype html><html></html>',
          })) as typeof window.fetch,
      }),
    ).rejects.toMatchObject({ code: 'APP_RESOURCE_DENIED' });
  });

  test('rejects another app path and pins shared cacheable resources to this app', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/_web/session')) {
        return fakeResponse({
          url: virtual('/centraid/todos/'),
          contentType: 'text/html',
          body: '<!doctype html><html><head></head><body></body></html>',
        });
      }
      return fakeResponse({ url, contentType: 'application/json', body: '{}' });
    });
    const prepared = await prepareOpaqueAppDocument({
      appId,
      launchUrl: virtual('/centraid/_web/session?code=one'),
      documentNonce: 'document-one',
      fetch: fetcher as typeof window.fetch,
    });

    await expect(
      prepared.fetchResource({
        url: virtual('/centraid/notes/_query/library.mjs'),
        method: 'GET',
        headers: [],
      }),
    ).rejects.toMatchObject({ code: 'APP_RESOURCE_DENIED' });
    await prepared.fetchResource({
      url: virtual('/centraid/_vault/blobs/shared-sha?__centraid_app=notes'),
      method: 'GET',
      headers: [],
    });

    expect(calls.at(-1)).toBe(virtual('/centraid/_vault/blobs/shared-sha?__centraid_app=todos'));
  });
});
