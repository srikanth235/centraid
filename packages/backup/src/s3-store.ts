/*
 * `ObjectStore` over a real S3-compatible endpoint via a short-lived `S3Grant`
 * (PROTOCOL.md § Credential grant). A minimal SigV4 signer using only
 * `fetch` + `node:crypto` — no AWS SDK, per the zero-new-dependencies rule.
 *
 * Region: `S3Grant` (PROTOCOL.md) carries no region field — every example
 * endpoint in the spec is Cloudflare R2, whose SigV4 profile is region
 * `"auto"`. This store hardcodes `"auto"`; a future provider needing a real
 * AWS region would need PROTOCOL.md to grow a field for it (out of scope
 * here — the reserved codes and grant shape are the seam, and region isn't
 * declared there).
 */

import { createHash, createHmac } from 'node:crypto';
import type { ObjectStore } from './object-store.js';
import { assertSafeKey } from './object-store.js';
import type { S3Grant } from './provider.js';

const REGION = 'auto';
const SERVICE = 's3';
const REFRESH_SLACK_SECONDS = 60;

function hex(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** AWS SigV4 URI-encoding: unreserved chars pass through, everything else is %XX. */
function awsUriEncode(input: string, encodeSlashChar: boolean): string {
  let out = encodeURIComponent(input).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  if (!encodeSlashChar) out = out.replace(/%2F/g, '/');
  return out;
}

function canonicalUri(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => awsUriEncode(seg, true))
    .join('/');
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(query[k] ?? '', true)}`)
    .join('&');
}

function amzTimestamp(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

function signRequest(opts: {
  grant: S3Grant;
  method: string;
  path: string; // includes leading "/", already bucket-prefixed
  query?: Record<string, string>;
  body?: Buffer;
  now?: Date;
}): SignedRequest {
  const { grant, method } = opts;
  const query = opts.query ?? {};
  const body = opts.body ?? Buffer.alloc(0);
  const url = new URL(grant.endpoint);
  const host = url.host;
  const { amzDate, dateStamp } = amzTimestamp(opts.now ?? new Date());
  const payloadHash = hex(body);

  const headerEntries: [string, string][] = [
    ['host', host],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', amzDate],
  ];
  if (grant.sessionToken) headerEntries.push(['x-amz-security-token', grant.sessionToken]);
  headerEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = headerEntries.map(([k]) => k).join(';');

  const canonicalRequest = [
    method,
    canonicalUri(opts.path),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');

  const kDate = hmac(Buffer.from(`AWS4${grant.secretAccessKey}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${grant.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const qs = canonicalQuery(query);
  const fullUrl = `${url.protocol}//${host}${canonicalUri(opts.path)}${qs ? `?${qs}` : ''}`;

  const headers: Record<string, string> = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization,
  };
  if (grant.sessionToken) headers['x-amz-security-token'] = grant.sessionToken;

  return { url: fullUrl, headers };
}

async function collectBody(data: Uint8Array | AsyncIterable<Uint8Array>): Promise<Buffer> {
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const parts: Buffer[] = [];
  for await (const chunk of data)
    parts.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  return Buffer.concat(parts);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function* streamResponseBody(res: Response): AsyncGenerator<Uint8Array> {
  if (!res.body) return;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface S3ObjectStoreOptions {
  /** Re-issue a fresh grant (new credentials/expiry) for the same target+mode. */
  refreshGrant?: () => Promise<S3Grant>;
}

/**
 * `ObjectStore` over an S3-compatible bucket, path-style
 * (`{endpoint}/{bucket}/{prefix}{key}`). Chunk/manifest objects are small
 * (<= 4 MiB) per FORMAT.md, so `put` buffers the whole body before signing
 * — SigV4 needs the payload hash up front regardless.
 */
export class S3ObjectStore implements ObjectStore {
  private grant: S3Grant;
  private readonly refreshGrant: (() => Promise<S3Grant>) | undefined;
  private refreshing: Promise<void> | null = null;

  constructor(grant: S3Grant, options: S3ObjectStoreOptions = {}) {
    this.grant = grant;
    this.refreshGrant = options.refreshGrant;
  }

  private async ensureFreshGrant(): Promise<void> {
    const nowSeconds = Date.now() / 1000;
    if (nowSeconds < this.grant.expiresAt - REFRESH_SLACK_SECONDS) return;
    if (!this.refreshGrant) return; // best-effort — caller may not have a refresher wired
    if (!this.refreshing) {
      this.refreshing = this.refreshGrant()
        .then((fresh) => {
          this.grant = fresh;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    await this.refreshing;
  }

  // Raw (unencoded) path — `signRequest` is the single place that percent-encodes
  // it, both for the canonical request (signature) and the actual request URL,
  // so the two can never drift out of sync (a double-encoding bug otherwise).
  private objectPath(key: string): string {
    assertSafeKey(key);
    return `/${this.grant.bucket}/${this.grant.prefix}${key}`;
  }

  private async request(
    method: string,
    pathAndKey: { path: string; query?: Record<string, string> },
    body?: Buffer,
  ): Promise<Response> {
    await this.ensureFreshGrant();
    const signed = signRequest({
      grant: this.grant,
      method,
      path: pathAndKey.path,
      ...(pathAndKey.query ? { query: pathAndKey.query } : {}),
      ...(body ? { body } : {}),
    });
    return fetch(signed.url, { method, headers: signed.headers, ...(body ? { body } : {}) });
  }

  async put(key: string, data: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
    if (this.grant.mode !== 'read-write') {
      throw new Error(`object store opened in "${this.grant.mode}" mode; put refused for "${key}"`);
    }
    const body = await collectBody(data);
    const res = await this.request('PUT', { path: this.objectPath(key) }, body);
    if (!res.ok) {
      throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.request('GET', { path: this.objectPath(key) });
    if (res.status === 404) throw new Error(`object not found: ${key}`);
    if (!res.ok) {
      throw new Error(`S3 GET ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  getStream(key: string): AsyncIterable<Uint8Array> {
    /** @yields Successive byte ranges of the response body, in order. */
    const gen = async function* (this: S3ObjectStore): AsyncGenerator<Uint8Array> {
      const res = await this.request('GET', { path: this.objectPath(key) });
      if (res.status === 404) throw new Error(`object not found: ${key}`);
      if (!res.ok) {
        throw new Error(`S3 GET ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
      }
      yield* streamResponseBody(res);
    }.bind(this);
    return gen();
  }

  async head(key: string): Promise<{ size: number } | null> {
    const res = await this.request('HEAD', { path: this.objectPath(key) });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
    }
    const len = res.headers.get('content-length');
    return { size: len ? Number.parseInt(len, 10) : 0 };
  }

  async *list(prefix: string): AsyncIterable<{ key: string; size: number }> {
    if (prefix.length > 0) assertSafeKey(prefix.endsWith('/') ? `${prefix}x` : prefix);
    const fullPrefix = `${this.grant.prefix}${prefix}`;
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: fullPrefix };
      if (continuationToken) query['continuation-token'] = continuationToken;
      const res = await this.request('GET', { path: `/${this.grant.bucket}`, query });
      if (!res.ok) {
        throw new Error(
          `S3 ListObjectsV2 failed: ${res.status} ${await res.text().catch(() => '')}`,
        );
      }
      const xml = await res.text();
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block);
        const sizeMatch = /<Size>(\d+)<\/Size>/.exec(block);
        if (!keyMatch) continue;
        const fullKey = unescapeXml(keyMatch[1] ?? '');
        if (!fullKey.startsWith(this.grant.prefix)) continue;
        yield {
          key: fullKey.slice(this.grant.prefix.length),
          size: sizeMatch ? Number.parseInt(sizeMatch[1] ?? '0', 10) : 0,
        };
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
      continuationToken = truncated && tokenMatch ? unescapeXml(tokenMatch[1] ?? '') : undefined;
    } while (continuationToken);
  }

  async delete(key: string): Promise<void> {
    if (this.grant.mode !== 'read-write') {
      throw new Error(
        `object store opened in "${this.grant.mode}" mode; delete refused for "${key}"`,
      );
    }
    const res = await this.request('DELETE', { path: this.objectPath(key) });
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
    }
  }
}
