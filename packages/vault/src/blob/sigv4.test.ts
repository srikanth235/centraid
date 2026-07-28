// Pure SigV4 unit tests (issue #545 B6) — no live S3 endpoint.

import { createHash, createHmac } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  encodeKeyPath,
  presignS3Request,
  sha256HexOf,
  signS3Request,
  type SignS3RequestParams,
} from './sigv4.js';

const CREDS = {
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

describe('sigv4', () => {
  test('sha256HexOf matches node crypto for empty and non-empty payloads', () => {
    expect(sha256HexOf(Buffer.alloc(0))).toBe(createHash('sha256').digest('hex'));
    expect(sha256HexOf('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256HexOf(Buffer.from([1, 2, 3]))).toBe(
      createHash('sha256')
        .update(Buffer.from([1, 2, 3]))
        .digest('hex'),
    );
  });

  test('encodeKeyPath encodes each segment and preserves slash structure', () => {
    expect(encodeKeyPath('blobs/sha256/abc')).toBe('blobs/sha256/abc');
    expect(encodeKeyPath('a b/c+d')).toBe('a%20b/c%2Bd');
    expect(encodeKeyPath("a'b")).toBe('a%27b');
    expect(encodeKeyPath('')).toBe('');
  });

  test('signS3Request produces Authorization with host/date/payload headers', () => {
    const base = new URL('https://s3.us-east-1.amazonaws.com');
    const params: SignS3RequestParams = {
      method: 'PUT',
      base,
      path: 'my-bucket/blobs/sha256/deadbeef',
      region: 'us-east-1',
      credentials: CREDS,
      body: Buffer.from('payload'),
      headers: {
        'content-type': 'application/octet-stream',
        'x-amz-storage-class': 'STANDARD',
      },
    };
    const signed = signS3Request(params);
    expect(signed.url.origin).toBe(base.origin);
    expect(signed.url.pathname).toBe('/my-bucket/blobs/sha256/deadbeef');
    expect(signed.headers.host).toBe(base.host);
    expect(signed.headers['x-amz-content-sha256']).toBe(sha256HexOf(Buffer.from('payload')));
    expect(signed.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/u);
    expect(signed.headers['content-type']).toBe('application/octet-stream');
    expect(signed.headers['x-amz-storage-class']).toBe('STANDARD');
    expect(signed.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=/u,
    );
    expect(signed.headers.Authorization).toContain('Signature=');
    // Every caller header is folded into SignedHeaders (no special casing).
    expect(signed.headers.Authorization).toContain('content-type');
    expect(signed.headers.Authorization).toContain('x-amz-storage-class');
  });

  test('signS3Request includes the session token when present', () => {
    const signed = signS3Request({
      method: 'GET',
      base: new URL('http://127.0.0.1:9000'),
      path: 'bucket/key',
      region: 'us-east-1',
      credentials: { ...CREDS, sessionToken: 'sess-token' },
    });
    expect(signed.headers['x-amz-security-token']).toBe('sess-token');
    expect(signed.headers.Authorization).toContain('x-amz-security-token');
  });

  test('signS3Request signature is deterministic for a fixed clock via recomputation', () => {
    // The signer uses `new Date()` internally; recompute with the same amz date
    // from the first response and assert the Authorization signature matches
    // the independent HMAC chain AWS documents.
    const base = new URL('https://s3.example.test');
    const path = 'bucket/obj';
    const region = 'eu-west-1';
    const signed = signS3Request({
      method: 'GET',
      base,
      path,
      region,
      credentials: CREDS,
    });
    const amzDate = signed.headers['x-amz-date']!;
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256HexOf(Buffer.alloc(0));
    const canonicalHeaders = `host:${base.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      'GET',
      `/${encodeKeyPath(path)}`,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256HexOf(canonicalRequest)].join(
      '\n',
    );
    const hmac = (key: Buffer | string, data: string) =>
      createHmac('sha256', key).update(data, 'utf8').digest();
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${CREDS.secretAccessKey}`, dateStamp), region), 's3'),
      'aws4_request',
    );
    const expectedSig = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    expect(signed.headers.Authorization).toContain(`Signature=${expectedSig}`);
  });

  test('presignS3Request mints a query-signed URL with UNSIGNED-PAYLOAD and capped expiry', () => {
    const now = new Date('2024-01-02T03:04:05.000Z');
    const url = presignS3Request({
      method: 'PUT',
      base: new URL('https://s3.us-west-2.amazonaws.com'),
      path: 'b/prefix/blobs/sha256/ab',
      region: 'us-west-2',
      credentials: CREDS,
      expiresSeconds: 600,
      now,
    });
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      `AKIAEXAMPLE/20240102/us-west-2/s3/aws4_request`,
    );
    expect(url.searchParams.get('X-Amz-Date')).toBe('20240102T030405Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/u);
    expect(url.pathname).toBe('/b/prefix/blobs/sha256/ab');
  });

  test('presignS3Request clamps expiry to the seven-day S3 cap and at least 1 second', () => {
    const now = new Date('2024-06-01T00:00:00.000Z');
    const long = presignS3Request({
      method: 'GET',
      base: new URL('https://s3.amazonaws.com'),
      path: 'b/k',
      region: 'us-east-1',
      credentials: CREDS,
      expiresSeconds: 999_999,
      now,
    });
    expect(long.searchParams.get('X-Amz-Expires')).toBe('604800');
    const short = presignS3Request({
      method: 'GET',
      base: new URL('https://s3.amazonaws.com'),
      path: 'b/k',
      region: 'us-east-1',
      credentials: CREDS,
      expiresSeconds: 0,
      now,
    });
    expect(short.searchParams.get('X-Amz-Expires')).toBe('1');
  });

  test('presignS3Request carries the session token as a query parameter', () => {
    const url = presignS3Request({
      method: 'GET',
      base: new URL('https://s3.amazonaws.com'),
      path: 'b/k',
      region: 'us-east-1',
      credentials: { ...CREDS, sessionToken: 'temp-token' },
      now: new Date('2024-01-01T00:00:00.000Z'),
    });
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('temp-token');
  });
});
