import { afterEach, describe, expect, it, vi } from 'vitest';
// The inline kit is imported FIRST so its `./suppress-served-ask` side effect
// runs before the real kit module (it suppresses kit.ts's auto-mounting Ask
// IIFE). These suites exercise the authed vault overrides — blob staging, the
// attach flow, and the owner-plane reference writes (issue #505 Phase 4).
import {
  createReference,
  reanchorReference,
  removeReference,
  stageDerivative,
  stageFileBytes,
  wireAttachInput,
} from './kit-inline.js';

// gateway-client-core touches window.CentraidApi at module load and is the one
// choke point every override routes through; stub it and capture the calls.
const doFetch = vi.fn();
vi.mock('../../gateway-client-core.js', () => ({
  auth: vi.fn(async () => ({ baseUrl: 'https://gw.test', token: 'tok' })),
  authHeaders: (token?: string, contentType?: string) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(contentType ? { 'Content-Type': contentType } : {}),
  }),
  doFetch: (...args: unknown[]) => doFetch(...args),
  readJson: vi.fn(),
}));

function res(init: { ok?: boolean; status?: number; body?: unknown; headers?: HeadersInit } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    json: async () => init.body ?? {},
  } as unknown as Response;
}

/** The [pathname, init] a given doFetch call was made with. */
function callArgs(index: number): [string, RequestInit] {
  const call = doFetch.mock.calls[index]!;
  return [call[1] as string, call[2] as RequestInit];
}

// jsdom's File does not implement `arrayBuffer()`, so kit.ts's `sha256File`
// returns null for a plain `new File(...)` and the sha-preflight path is
// skipped. This file-like carries `arrayBuffer` (and no `stream`) so the pure-JS
// StreamingSha256 hashes it — exercising the dedupe branch the way a browser
// File would.
function hashableFile(bytes: Uint8Array, name: string, type: string): File {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File;
}

afterEach(() => {
  doFetch.mockReset();
});

describe('kit-inline blob staging', () => {
  it('stageFileBytes POSTs the file to the authed blob route (no hash)', async () => {
    doFetch.mockResolvedValueOnce(res({ body: { sha256: 'deadbeef' } }));
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });

    const staged = await stageFileBytes(file, '', { hash: false });

    expect(staged).toEqual({ sha256: 'deadbeef' });
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [pathname, init] = callArgs(0);
    expect(pathname.startsWith('/centraid/_vault/blobs?')).toBe(true);
    expect(pathname).toContain('filename=note.txt');
    expect(pathname).toContain('media_type=text%2Fplain');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['content-type']).toBe('text/plain');
    expect(headers['x-content-sha256']).toBeUndefined();
    expect(init.body).toBe(file);
  });

  it('stageFileBytes preflights by sha and short-circuits when the CAS already has it', async () => {
    doFetch.mockImplementation(async (_base: string, _path: string, init: RequestInit) =>
      init.method === 'HEAD'
        ? res({
            headers: {
              'x-centraid-media-type': 'image/png',
              'content-length': '2048',
              'x-centraid-content-id': 'ci-1',
              'x-centraid-cas-ack': 'replicated',
              'x-centraid-custody': 'remote-only',
            },
          })
        : res({ body: { sha256: 'should-not-post' } }),
    );
    const file = hashableFile(new Uint8Array(64), 'pic.png', 'image/png');

    const staged = await stageFileBytes(file);

    // One HEAD preflight, no POST.
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [pathname, init] = callArgs(0);
    expect(init.method).toBe('HEAD');
    expect(pathname).toContain('/centraid/_vault/blobs/_sha/');
    expect(pathname).toContain('byte_size=64');
    expect(staged.alreadyPresent).toBe(true);
    expect(staged.mediaType).toBe('image/png');
    expect(staged.byteSize).toBe(2048);
    expect(staged.existingContentId).toBe('ci-1');
    expect(staged.custody).toBe('remote-only');
  });

  it('stageFileBytes hashes, misses the preflight, then POSTs with x-content-sha256', async () => {
    doFetch.mockImplementation(async (_base: string, _path: string, init: RequestInit) =>
      init.method === 'HEAD' ? res({ ok: false, status: 404 }) : res({ body: { sha256: 'h' } }),
    );
    const file = hashableFile(new Uint8Array(8), 'a.bin', 'application/octet-stream');

    await stageFileBytes(file);

    expect(doFetch).toHaveBeenCalledTimes(2);
    const [headPath, headInit] = callArgs(0);
    expect(headInit.method).toBe('HEAD');
    expect(headPath).toContain('/centraid/_vault/blobs/_sha/');
    const [postPath, postInit] = callArgs(1);
    expect(postInit.method).toBe('POST');
    expect(postPath).toContain('sha256=');
    expect((postInit.headers as Record<string, string>)['x-content-sha256']).toBeTruthy();
  });

  it('stageFileBytes throws on a refused upload', async () => {
    doFetch.mockResolvedValueOnce(res({ ok: false, status: 507 }));
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    await expect(stageFileBytes(file, '', { hash: false })).rejects.toThrow('upload refused (507)');
  });

  it('stageDerivative POSTs a variant contribution to the blob route', async () => {
    doFetch.mockResolvedValueOnce(res({ body: { sha256: 'thumb' } }));
    const blob = new Blob([new Uint8Array(4)], { type: 'image/jpeg' });

    const staged = await stageDerivative('parent-sha', 'thumb', blob, 'image/jpeg');

    expect(staged).toEqual({ sha256: 'thumb' });
    const [pathname, init] = callArgs(0);
    expect(pathname).toContain('variant=thumb');
    expect(pathname).toContain('variant_of=parent-sha');
    expect(pathname).toContain('media_type=image%2Fjpeg');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('image/jpeg');
    expect(init.body).toBe(blob);
  });
});

describe('kit-inline wireAttachInput', () => {
  function fileInput(): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'file';
    return el;
  }
  function setFiles(el: HTMLInputElement, files: File[]): void {
    Object.defineProperty(el, 'files', { configurable: true, value: files });
  }

  it('inlines a small file as a data: URI through the app action (no upload)', async () => {
    const el = fileInput();
    const act = vi.fn(async (_action: string, _input: Record<string, unknown>) => ({
      status: 'executed',
    }));
    const narrate = vi.fn(() => true);
    const refresh = vi.fn();
    wireAttachInput(el, () => 'note-1', { act, narrate, refresh });

    setFiles(el, [new File(['tiny'], 'tiny.txt', { type: 'text/plain' })]);
    el.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());

    expect(doFetch).not.toHaveBeenCalled();
    expect(act).toHaveBeenCalledTimes(1);
    const [action, input] = act.mock.calls[0]!;
    expect(action).toBe('attach');
    expect(input.subject_id).toBe('note-1');
    expect(String(input.data_uri)).toContain('data:text/plain');
  });

  it('stages a >256 KiB file through the authed blob route, then attaches by sha', async () => {
    doFetch.mockImplementation(async (_base: string, _path: string, init: RequestInit) =>
      init.method === 'HEAD'
        ? res({ ok: false, status: 404 })
        : res({ body: { sha256: 'big-sha' } }),
    );
    const el = fileInput();
    const act = vi.fn(async (_action: string, _input: Record<string, unknown>) => ({
      status: 'executed',
    }));
    const narrate = vi.fn(() => true);
    const refresh = vi.fn();
    wireAttachInput(el, () => 'note-2', { act, narrate, refresh });

    const big = new File([new Uint8Array(300 * 1024)], 'big.bin', {
      type: 'application/octet-stream',
    });
    setFiles(el, [big]);
    el.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());

    expect(doFetch).toHaveBeenCalled();
    const [action, input] = act.mock.calls[0]!;
    expect(action).toBe('attach');
    expect(input.subject_id).toBe('note-2');
    expect(input.staged_sha).toBe('big-sha');
    expect(input.data_uri).toBeUndefined();
  });

  it('does nothing when there is no attach subject', async () => {
    const el = fileInput();
    const act = vi.fn(async (_action: string, _input: Record<string, unknown>) => ({
      status: 'executed',
    }));
    wireAttachInput(el, () => null, { act, narrate: () => true });
    setFiles(el, [new File(['x'], 'x.txt', { type: 'text/plain' })]);
    el.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(act).not.toHaveBeenCalled();
  });
});

describe('kit-inline reference writes', () => {
  it('createReference POSTs the link with the owner bearer credential', async () => {
    doFetch.mockResolvedValueOnce(res({ body: { status: 'executed' } }));

    const outcome = await createReference(
      { type: 'knowledge.note', id: 'n1' },
      { type: 'core.party', id: 'p1' },
      'references',
      { exact: 'Ada' },
    );

    expect(outcome).toEqual({ status: 'executed' });
    const [pathname, init] = callArgs(0);
    expect(pathname).toBe('/centraid/_vault/links');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      from_type: 'knowledge.note',
      from_id: 'n1',
      to_type: 'core.party',
      to_id: 'p1',
      relation: 'references',
      selector: { exact: 'Ada' },
    });
  });

  it('createReference defaults the relation and omits an absent selector', async () => {
    doFetch.mockResolvedValueOnce(res({ body: { status: 'executed' } }));
    await createReference({ type: 't', id: 'a' }, { type: 'u', id: 'b' }, '');
    const body = JSON.parse(String(callArgs(0)[1].body));
    expect(body.relation).toBe('references');
    expect('selector' in body).toBe(false);
  });

  it('removeReference DELETEs the encoded link id', async () => {
    doFetch.mockResolvedValueOnce(res({ body: { status: 'executed' } }));
    await removeReference('link/42');
    const [pathname, init] = callArgs(0);
    expect(pathname).toBe('/centraid/_vault/links/link%2F42');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('reanchorReference PATCHes the selector (null clears the anchor)', async () => {
    doFetch.mockResolvedValue(res({ body: { status: 'executed' } }));

    await reanchorReference('lk1', { exact: 'moved' });
    expect(callArgs(0)[1].method).toBe('PATCH');
    expect(JSON.parse(String(callArgs(0)[1].body))).toEqual({ selector: { exact: 'moved' } });

    await reanchorReference('lk1', null);
    expect(JSON.parse(String(callArgs(1)[1].body))).toEqual({ selector: null });
  });
});
