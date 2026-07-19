import { describe, expect, it } from 'vitest';
import { createBlobHandoffUrl } from './data-plane-handoff.js';

describe('createBlobHandoffUrl', () => {
  const options = {
    baseUrl: 'http://127.0.0.1:18891',
    secret: '0123456789abcdef0123456789abcdef',
    rootDir: '/vaults',
  };

  it('signs a root-relative, short-lived one-use ticket payload', () => {
    const url = new URL(
      createBlobHandoffUrl(options, {
        file: '/vaults/v1/blobs/sha256/ab/abc',
        mediaType: 'image/jpeg',
        disposition: 'inline; filename="x.jpg"',
        etag: '"abc"',
        nowMs: 1_000,
      })!,
    );
    const [payload, signature] = url.searchParams.get('ticket')!.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as {
      relativePath: string;
      expiresAtMs: number;
      nonce: string;
    };
    expect(decoded.relativePath).toBe('v1/blobs/sha256/ab/abc');
    expect(decoded.expiresAtMs).toBe(11_000);
    expect(decoded.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a path outside the configured data root', () => {
    expect(
      createBlobHandoffUrl(options, {
        file: '/other/secret',
        mediaType: 'text/plain',
        disposition: 'inline',
        etag: '"x"',
      }),
    ).toBeUndefined();
  });
});
