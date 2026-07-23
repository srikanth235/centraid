import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The inline kit is imported (transitively, via the module under test) FIRST so
// its `./suppress-served-ask` side effect runs before the real kit module. This
// suite exercises the generic blob-image authorizer (issue #505 Phase 4).
import { installInlineBlobImages } from './inline-blob-images.js';

// gateway-client-core is the choke point authorizeBlobUrl routes through; stub
// it and hand back a fake blob per request.
const doFetch = vi.fn();
vi.mock('../../gateway-client-core.js', () => ({
  auth: vi.fn(async () => ({ baseUrl: 'https://gw.test', token: 'tok' })),
  authHeaders: (token?: string) => (token ? { Authorization: `Bearer ${token}` } : {}),
  doFetch: (...args: unknown[]) => doFetch(...args),
  readJson: vi.fn(),
}));

function blobRes(ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: new Headers(),
    blob: async () => new Blob(['bytes'], { type: 'image/jpeg' }),
  } as unknown as Response;
}

let created: string[] = [];
let revoked: string[] = [];
let seq = 0;

beforeEach(() => {
  created = [];
  revoked = [];
  seq = 0;
  // jsdom implements neither createObjectURL nor revokeObjectURL — supply both.
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => {
    const url = `blob:mock/${++seq}`;
    created.push(url);
    return url;
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u: string) => {
    revoked.push(u);
  };
  doFetch.mockImplementation(async () => blobRes(true));
});

afterEach(() => {
  doFetch.mockReset();
  document.body.innerHTML = '';
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('installInlineBlobImages', () => {
  it('swaps an <img> src pointing at /_vault/blobs to an authed object URL', async () => {
    const root = document.createElement('div');
    const img = document.createElement('img');
    img.setAttribute('src', '/centraid/_vault/blobs/abc?variant=thumb');
    root.appendChild(img);
    document.body.appendChild(root);

    const teardown = installInlineBlobImages(root);
    await flush();

    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch.mock.calls[0]?.[1]).toBe('/centraid/_vault/blobs/abc?variant=thumb');
    expect(img.getAttribute('src')).toMatch(/^blob:mock\//);
    teardown();
  });

  it('rewrites data-prefetch-src BEFORE it becomes src (the lazy grid path)', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const teardown = installInlineBlobImages(root);

    // media-observer stages the blob URL here, ahead of the viewport.
    const img = document.createElement('img');
    img.dataset.prefetchSrc = '/centraid/_vault/blobs/lazy';
    root.appendChild(img);
    await flush();

    const staged = img.dataset.prefetchSrc;
    expect(staged).toMatch(/^blob:mock\//);
    // When the tile scrolls in, media-observer copies the (now authed) staged URL
    // into src — never an unauthorized /_vault/blobs URL, so no onerror.
    expect(staged?.startsWith('/centraid/_vault/blobs')).toBe(false);
    teardown();
  });

  it('authorizes a CSS background-image url() (album covers)', async () => {
    const root = document.createElement('div');
    const cover = document.createElement('span');
    cover.style.backgroundImage = 'url(/centraid/_vault/blobs/cover1)';
    root.appendChild(cover);
    document.body.appendChild(root);

    const teardown = installInlineBlobImages(root);
    await flush();

    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(cover.style.backgroundImage).toMatch(/^url\("blob:mock\//);
    teardown();
  });

  it('leaves non-blob and already-authed refs untouched', async () => {
    const root = document.createElement('div');
    const dataImg = document.createElement('img');
    dataImg.setAttribute('src', 'data:image/png;base64,AAAA');
    const blobImg = document.createElement('img');
    blobImg.setAttribute('src', 'blob:mock/existing');
    root.append(dataImg, blobImg);
    document.body.appendChild(root);

    const teardown = installInlineBlobImages(root);
    await flush();

    expect(doFetch).not.toHaveBeenCalled();
    expect(dataImg.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    teardown();
  });

  it('revokes every object URL it created on teardown (no leak)', async () => {
    const root = document.createElement('div');
    const a = document.createElement('img');
    a.setAttribute('src', '/centraid/_vault/blobs/a');
    const b = document.createElement('img');
    b.setAttribute('src', '/centraid/_vault/blobs/b');
    root.append(a, b);
    document.body.appendChild(root);

    const teardown = installInlineBlobImages(root);
    await flush();
    expect(created).toHaveLength(2);
    expect(revoked).toHaveLength(0);

    teardown();
    expect(revoked.sort()).toEqual([...created].sort());
  });

  it('stops authorizing after teardown and revokes a late-arriving object URL', async () => {
    let resolveFetch: (r: Response) => void = () => undefined;
    doFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const root = document.createElement('div');
    const img = document.createElement('img');
    img.setAttribute('src', '/centraid/_vault/blobs/slow');
    root.appendChild(img);
    document.body.appendChild(root);

    const teardown = installInlineBlobImages(root);
    await flush();
    teardown(); // tears down while the authorize fetch is still in flight

    resolveFetch(blobRes(true));
    await flush();

    // The late object URL is created then immediately revoked; src is never set.
    expect(img.getAttribute('src')).toBe('/centraid/_vault/blobs/slow');
    expect(revoked).toEqual(created);
  });
});
