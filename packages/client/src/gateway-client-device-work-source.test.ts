import { beforeAll, beforeEach, expect, test, vi } from 'vitest';

type Bytes = Uint8Array<ArrayBuffer>;
let readSource: typeof import('./gateway-client-devices.js').readGatewayDeviceWorkSource;

beforeAll(async () => {
  (window as unknown as { CentraidApi: unknown }).CentraidApi = {
    getGatewayAuth: async () => ({
      baseUrl: 'https://gateway.test',
      token: 'device-token',
      vaultId: 'vault-wrong-default',
    }),
    onGatewayChanged: () => () => undefined,
    onVaultChanged: () => () => undefined,
  };
  ({ readGatewayDeviceWorkSource: readSource } = await import('./gateway-client-devices.js'));
});

beforeEach(() => vi.restoreAllMocks());

function concat(parts: Bytes[]): Bytes {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function ascii(value: string): Bytes {
  return new TextEncoder().encode(value);
}

function hexBytes(hex: string): Bytes {
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

async function gcm(
  key: CryptoKey,
  nonceByte: number,
  plain: Bytes,
  additionalData: string,
): Promise<Bytes> {
  const nonce = new Uint8Array(12);
  nonce.fill(nonceByte);
  const sealed = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: ascii(additionalData),
      tagLength: 128,
    },
    key,
    plain,
  );
  return concat([nonce, new Uint8Array(sealed)]);
}

async function fixture(
  plain: Bytes,
): Promise<{ sealed: Bytes; keyBase64: string; sha256: string }> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', plain));
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const frameSize = 7;
  const frameCount = Math.ceil(plain.byteLength / frameSize);
  const frames: Bytes[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const body = concat([
      Uint8Array.of(0),
      plain.slice(index * frameSize, Math.min(plain.byteLength, (index + 1) * frameSize)),
    ]);
    frames.push(await gcm(key, index + 1, body, `blob:${sha256}:v2:f${index}/${frameCount}`));
  }
  const directoryPlain = new Uint8Array(16 + frameCount * 4);
  const directoryView = new DataView(directoryPlain.buffer);
  directoryView.setUint32(0, frameSize, false);
  directoryView.setBigUint64(4, BigInt(plain.byteLength), false);
  directoryView.setUint32(12, frameCount, false);
  frames.forEach((frame, index) =>
    directoryView.setUint32(16 + index * 4, frame.byteLength, false),
  );
  const directory = await gcm(key, 250, directoryPlain, `blobdir:${sha256}:v2:n${frameCount}`);
  const header = concat([ascii('CBSF'), Uint8Array.of(2), hexBytes(sha256)]);
  const trailer = new Uint8Array(13);
  trailer.set(ascii('CBSF'));
  trailer[4] = 2;
  const trailerView = new DataView(trailer.buffer);
  trailerView.setUint32(5, directory.byteLength, false);
  trailerView.setUint32(9, frameCount, false);
  return {
    sealed: concat([header, ...frames, directory, trailer]),
    keyBase64: btoa(String.fromCharCode(...keyBytes)),
    sha256,
  };
}

function requestedRange(init: RequestInit | undefined): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get('range');
  if (Array.isArray(headers)) {
    return headers.find(([name]) => name.toLowerCase() === 'range')?.[1] ?? null;
  }
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'range');
  return typeof entry?.[1] === 'string' ? entry[1] : null;
}

async function readBlob(blob: Blob): Promise<Bytes> {
  const native = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof native.arrayBuffer === 'function') {
    return new Uint8Array(await native.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(new Uint8Array(reader.result as ArrayBuffer)));
    reader.addEventListener('error', () => reject(reader.error));
    // eslint-disable-next-line unicorn/prefer-blob-reading-methods -- jsdom's Blob lacks arrayBuffer(); governance: allow-no-unjustified-suppressions test-environment compatibility (#414)
    reader.readAsArrayBuffer(blob);
  });
}

test('client authorizes direct source, range-unseals provider bytes, and never pulls through Pi', async () => {
  const plain = ascii('representative video bytes for a device poster');
  const sealed = await fixture(plain);
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.startsWith('https://gateway.test/centraid/_vault/blobs/direct/')) {
        return Response.json({
          url: 'https://provider.test/object',
          keyBase64: sealed.keyBase64,
          contentKey: { wrappedKeyBase64: 'native-envelope' },
        });
      }
      if (url === 'https://provider.test/object') {
        const value = requestedRange(init);
        expect(value).toMatch(/^bytes=/);
        let start: number;
        let end: number;
        if (value!.startsWith('bytes=-')) {
          const length = Number(value!.slice('bytes=-'.length));
          start = sealed.sealed.byteLength - length;
          end = sealed.sealed.byteLength - 1;
        } else {
          const match = value!.match(/^bytes=([0-9]+)-([0-9]+)$/)!;
          start = Number(match[1]);
          end = Number(match[2]);
        }
        return new Response(sealed.sealed.slice(start, end + 1), {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${sealed.sealed.byteLength}` },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );

  const blob = await readSource({
    vaultId: 'vault-1',
    contentId: 'content-1',
    sha256: sealed.sha256,
    mediaType: 'video/mp4',
  });
  expect(Array.from(await readBlob(blob))).toEqual(Array.from(plain));
  expect(blob.type).toBe('video/mp4');
  const authorize = calls[0]!;
  expect(authorize.url).toBe(
    `https://gateway.test/centraid/_vault/blobs/direct/${sealed.sha256}/download`,
  );
  expect(new Headers(authorize.init?.headers).get('x-centraid-vault')).toBe('vault-1');
  expect(calls.some((call) => call.url.includes('/blobs/content-1'))).toBe(false);
  expect(
    calls.filter((call) => call.url === 'https://provider.test/object').length,
  ).toBeGreaterThan(3);
});

test('local-primary source falls back through the gateway by content id, never sha', async () => {
  const plain = ascii('small local-only PDF bytes');
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/blobs/direct/')) {
        return Response.json({ error: 'remote_unavailable' }, { status: 503 });
      }
      if (url.endsWith('/centraid/_vault/blobs/content-local')) {
        return new Response(plain, { headers: { 'content-type': 'application/pdf' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );

  const blob = await readSource({
    vaultId: 'vault-1',
    contentId: 'content-local',
    sha256: 'c'.repeat(64),
    mediaType: 'application/pdf',
  });
  expect(Array.from(await readBlob(blob))).toEqual(Array.from(plain));
  expect(calls).toEqual([
    `https://gateway.test/centraid/_vault/blobs/direct/${'c'.repeat(64)}/download`,
    'https://gateway.test/centraid/_vault/blobs/content-local',
  ]);
});
