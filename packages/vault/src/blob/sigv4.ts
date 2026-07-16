// AWS Signature v4 request signing for the S3-compatible blob driver
// (extracted from s3.ts when issue #405 §4/§6 pushed that file past the
// 500-line governance cap — see s3.ts's header for the driver's trust
// posture). Pure functions over crypto primitives, no I/O: given a request's
// shape and credentials, produce the final signed URL + header set for
// `fetch`. Kept sibling to s3.ts so the signer and the driver evolve
// together, and unit-testable without a live endpoint.

import { createHash, createHmac } from 'node:crypto';
import type { S3Credentials } from './s3.js';

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function encodeQueryPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function amzDateOf(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function scopeOf(dateStamp: string, region: string): string {
  return `${dateStamp}/${region}/s3/aws4_request`;
}

function signingKeyOf(creds: S3Credentials, dateStamp: string, region: string): Buffer {
  return hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, dateStamp), region), 's3'),
    'aws4_request',
  );
}

function signatureOf(key: Buffer, stringToSign: string): string {
  return createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
}

/** Lowercase-hex SHA-256, used for both the payload hash and the string-to-sign. */
export function sha256HexOf(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 encode one S3 key segment (SigV4 canonical form). */
export function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

export interface SignS3RequestParams {
  method: string;
  /** Origin of the endpoint (`new URL(endpoint)`), for host + URL assembly. */
  base: URL;
  /** Path-style object path, e.g. `bucket/prefix/blobs/sha256/<sha>` ('' = bucket root). */
  path: string;
  region: string;
  credentials: S3Credentials;
  body?: Buffer;
  /**
   * Caller headers (e.g. content-type, range, `x-amz-storage-class` for
   * issue #405 §6) — EVERY entry here is folded into SignedHeaders, so a
   * storage-class header is signed exactly like host/date with no special
   * casing. Names are lowercased before signing.
   */
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface SignedS3Request {
  url: URL;
  headers: Record<string, string>;
}

/**
 * Sign one S3 request (SigV4, path-style). Returns the target URL and the
 * complete header set — the amz date/content-sha256/security-token, the
 * caller's headers, and the `Authorization` line — ready to hand to `fetch`.
 */
export function signS3Request(params: SignS3RequestParams): SignedS3Request {
  const { method, base, path, region, credentials: creds, body } = params;
  const now = new Date();
  const amzDate = amzDateOf(now);
  const dateStamp = amzDate.slice(0, 8);

  const canonicalPath = `/${encodeKeyPath(path)}`;
  const query = params.query ?? {};
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? '')}`)
    .join('&');

  const payloadHash = sha256HexOf(body ?? Buffer.alloc(0));
  const headers: Record<string, string> = {
    host: base.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
    ...Object.fromEntries(
      Object.entries(params.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headers[k]!.trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = scopeOf(dateStamp, region);
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256HexOf(canonicalRequest)].join(
    '\n',
  );
  const signature = signatureOf(signingKeyOf(creds, dateStamp, region), stringToSign);

  const url = new URL(base.origin);
  url.pathname = canonicalPath;
  url.search = canonicalQuery;
  return {
    url,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export interface PresignS3RequestParams {
  method: 'GET' | 'PUT';
  base: URL;
  path: string;
  region: string;
  credentials: S3Credentials;
  /** S3 caps SigV4 query credentials at seven days. */
  expiresSeconds?: number;
  query?: Record<string, string>;
  now?: Date;
}

/**
 * Mint a query-signed S3 URL suitable for an untrusted byte carrier. Only
 * `host` is signed so a phone/browser can stream its body without first
 * buffering a payload hash; the CBSF envelope + completion HEAD are the
 * content integrity/custody checks.
 */
export function presignS3Request(params: PresignS3RequestParams): URL {
  const creds = params.credentials;
  const now = params.now ?? new Date();
  const expires = Math.max(1, Math.min(604_800, Math.floor(params.expiresSeconds ?? 900)));
  const amzDate = amzDateOf(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = scopeOf(dateStamp, params.region);
  const query: Record<string, string> = {
    ...params.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
    ...(creds.sessionToken ? { 'X-Amz-Security-Token': creds.sessionToken } : {}),
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${encodeQueryPart(key)}=${encodeQueryPart(query[key] ?? '')}`)
    .join('&');
  const canonicalPath = `/${encodeKeyPath(params.path)}`;
  const canonicalRequest = [
    params.method,
    canonicalPath,
    canonicalQuery,
    `host:${params.base.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256HexOf(canonicalRequest)].join(
    '\n',
  );
  const signature = signatureOf(signingKeyOf(creds, dateStamp, params.region), stringToSign);
  const url = new URL(params.base.origin);
  url.pathname = canonicalPath;
  url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return url;
}
