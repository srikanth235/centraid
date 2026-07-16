/* oxlint-disable typescript-eslint/ban-ts-comment -- browser module exercised in jsdom */
// @ts-nocheck
// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PKG = path.resolve(import.meta.dirname, '..');
const moduleUrl = pathToFileURL(path.resolve(PKG, 'kit/edge-upload.js')).href;
const { sha256FileStream, stageDirectFile, stageFallbackFile } = await import(moduleUrl);

afterEach(() => vi.unstubAllGlobals());

describe('edge-sealed direct upload', () => {
  it('hashes a streamed file without materializing it through SubtleCrypto', async () => {
    const bytes = Buffer.from('device-preferred hashing');
    const file = new NodeFile([bytes], 'hash.txt');
    expect(await sha256FileStream(file)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('resumes the fallback door from the gateway durable offset before committing', async () => {
    const sha256 = '12'.repeat(32);
    const uploaded: Uint8Array[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/uploads')) {
        return Response.json({ mode: 'spool', sessionId: 'fallback-1', offset: 4 });
      }
      if (url.endsWith('/uploads/fallback-1') && init?.method === 'PATCH') {
        uploaded.push(new Uint8Array(await (init.body as Blob).arrayBuffer()));
        return new Response(null, { status: 204, headers: { 'upload-offset': '9' } });
      }
      if (url.endsWith('/uploads/fallback-1/commit')) {
        return Response.json({ sha256, byteSize: 9, custody: 'pending-offsite' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await stageFallbackFile(
      new NodeFile([Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8)], 'resume.bin'),
      sha256,
    );

    expect(uploaded).toEqual([Uint8Array.of(4, 5, 6, 7, 8)]);
    expect(result).toMatchObject({ sha256, custody: 'pending-offsite' });
    expect(fetchMock.mock.calls.at(-1)![0]).toContain('/commit');
  });

  it('hands an unavailable direct door back to the permanent gateway fallback', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const fetchMock = vi.fn(async () =>
      Response.json({ error: 'remote_unavailable' }, { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      stageDirectFile(new NodeFile([Uint8Array.of(1)], 'thin.bin'), '34'.repeat(32)),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hands a first provider PUT failure back to the durable gateway door', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    const rawKey = Buffer.alloc(32, 5).toString('base64');
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/direct')) {
        return Response.json({
          sessionId: 'provider-down',
          alreadyPresent: false,
          keyBase64: rawKey,
          upload: { kind: 'single', url: 'https://provider.example/upload' },
        });
      }
      if (url === 'https://provider.example/upload') {
        return new Response(null, { status: 503 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      stageDirectFile(new NodeFile([Uint8Array.of(1, 2)], 'offline.bin'), '56'.repeat(32)),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('puts CBSF v2 ciphertext to the presigned URL before claiming completion', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    const sha256 = 'ab'.repeat(32);
    const rawKey = Buffer.alloc(32, 7).toString('base64');
    let uploaded: Blob | undefined;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/direct')) {
        return Response.json({
          sessionId: 'session-1',
          alreadyPresent: false,
          custody: 'pending-offsite',
          contentKey: { keyBase64: rawKey },
          upload: { kind: 'single', url: 'https://provider.example/upload' },
        });
      }
      if (url === 'https://provider.example/upload') {
        uploaded = init?.body as Blob;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/direct/session-1/complete')) {
        return Response.json({ sha256, byteSize: 3, custody: 'remote-only' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await stageDirectFile(
      new NodeFile([Uint8Array.of(1, 2, 3)], 'tiny.bin', {
        type: 'application/octet-stream',
      }),
      sha256,
    );

    expect(result).toMatchObject({ sha256, custody: 'remote-only' });
    expect(uploaded).toBeDefined();
    const bytes = new Uint8Array(await uploaded!.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('CBSF');
    expect(bytes[4]).toBe(2);
    expect(Buffer.from(bytes.subarray(5, 37)).toString('hex')).toBe(sha256);
    expect(bytes.byteLength).toBe(3 + 94 + 33);
    expect(fetchMock.mock.calls[2]![0]).toContain('/direct/session-1/complete');
  });

  it('resumes multipart work by sealing only provider-missing parts and recording each ETag', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    const sha256 = 'cd'.repeat(32);
    const rawKey = Buffer.alloc(32, 9).toString('base64');
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/direct')) {
        return Response.json({
          sessionId: 'resume-1',
          alreadyPresent: false,
          keyBase64: rawKey,
          contentKey: { keyBase64: rawKey },
          completedParts: [{ partNumber: 1, etag: 'done' }],
          upload: {
            kind: 'multipart',
            uploadId: 'upload-1',
            parts: [{ partNumber: 2, url: 'https://provider.example/part-2' }],
          },
        });
      }
      if (url === 'https://provider.example/part-2') {
        return new Response(null, { status: 200, headers: { etag: 'part-2-etag' } });
      }
      if (url.endsWith('/parts/2')) return Response.json({ completedParts: [1, 2] });
      if (url.endsWith('/complete')) {
        return Response.json({ sha256, byteSize: 16 * 1024 ** 2 + 1, custody: 'remote-only' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const block = new Uint8Array(4 * 1024 ** 2);
    const file = new NodeFile([block, block, block, block, Uint8Array.of(1)], 'large.bin');

    await stageDirectFile(file, sha256);

    expect(calls.filter((url) => url.includes('provider.example'))).toEqual([
      'https://provider.example/part-2',
    ]);
    expect(calls.some((url) => url.endsWith('/parts/2'))).toBe(true);
    expect(calls.some((url) => url.endsWith('/complete'))).toBe(true);
  });

  it('schedules every multipart PUT with the native background session before awaiting suspension-safe completion', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('Blob', NodeBlob);
    const sha256 = 'ef'.repeat(32);
    const rawKey = Buffer.alloc(32, 11).toString('base64');
    const releases: Array<(value: unknown) => void> = [];
    const putBackground = vi.fn(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    vi.stubGlobal('centraid', { transfer: { putBackground } });
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/direct')) {
        return Response.json({
          sessionId: 'background-1',
          alreadyPresent: false,
          keyBase64: rawKey,
          upload: {
            kind: 'multipart',
            uploadId: 'upload-background',
            parts: [
              { partNumber: 1, url: 'https://provider.example/background-1' },
              { partNumber: 2, url: 'https://provider.example/background-2' },
            ],
          },
        });
      }
      if (url.endsWith('/parts/1') || url.endsWith('/parts/2')) {
        return Response.json({ completedParts: [] });
      }
      if (url.endsWith('/complete')) {
        return Response.json({ sha256, byteSize: 16 * 1024 ** 2 + 1, custody: 'remote-only' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const block = new Uint8Array(4 * 1024 ** 2);
    const file = new NodeFile([block, block, block, block, Uint8Array.of(1)], 'background.bin');

    const upload = stageDirectFile(file, sha256);
    await vi.waitFor(() => expect(putBackground).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/parts/'))).toBe(false);

    releases[0]!({ status: 200, headers: { ETag: 'native-part-1' } });
    releases[1]!({ status: 200, headers: { etag: 'native-part-2' } });
    await expect(upload).resolves.toMatchObject({ sha256, custody: 'remote-only' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/parts/'))).toHaveLength(2);
    expect(fetchMock.mock.calls.at(-1)![0]).toContain('/complete');
  });
});
