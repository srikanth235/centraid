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
  const service = 's3';
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
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
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256HexOf(canonicalRequest)].join(
    '\n',
  );
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

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
