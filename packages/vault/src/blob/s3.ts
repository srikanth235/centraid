// The S3-compatible remote driver (issue #296 phase 3). Talks AWS Signature
// v4 over plain fetch — no SDK dependency — so any S3-compatible endpoint
// (AWS, MinIO, R2, B2, Garage) works with `{endpoint, bucket, region,
// prefix}`. Credentials never live in settings: they arrive through an async
// provider the host wires to the broker/sealed-secret path (issue #290/#293).
//
// Trust posture: the gateway computes every content hash from its local
// spool — this driver's ETags are never believed, and a hostile endpoint can
// at worst lose bytes (which the reconciliation sweep reports), never
// corrupt identity.

import { createHash, createHmac } from 'node:crypto';
import { assertSha, type BlobRange, type BlobStat, type BlobStore } from './store.js';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** STS-style temporary credentials carry one. */
  sessionToken?: string;
}

export interface S3BlobStoreOptions {
  /** e.g. `https://s3.us-east-1.amazonaws.com` or `http://127.0.0.1:9000`. */
  endpoint: string;
  bucket: string;
  /** SigV4 region; S3-compatibles usually accept anything. */
  region?: string;
  /** Key prefix inside the bucket, e.g. `vaults/v1`. */
  prefix?: string;
  /** Path-style (`/bucket/key`) is the default — it works everywhere. */
  credentials: () => Promise<S3Credentials>;
  /** Test seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256HexOf(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 encode one S3 key segment (SigV4 canonical form). */
function encodeKeyPath(key: string): string {
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

export class S3BlobStore implements BlobStore {
  readonly kind = 's3';
  private readonly base: URL;

  constructor(private readonly options: S3BlobStoreOptions) {
    this.base = new URL(options.endpoint);
  }

  private keyFor(sha: string): string {
    assertSha(sha);
    const prefix = this.options.prefix ? this.options.prefix.replace(/\/+$/, '') + '/' : '';
    return `${prefix}blobs/sha256/${sha}`;
  }

  /**
   * One signed S3 request. Bodies are buffered — blob puts arrive as whole
   * buffers from the local spool, and gets are bounded by Range.
   */
  private async request(
    method: string,
    key: string,
    opts: { body?: Buffer; headers?: Record<string, string>; query?: Record<string, string> } = {},
  ): Promise<Response> {
    const creds = await this.options.credentials();
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const region = this.options.region ?? 'us-east-1';
    const service = 's3';

    const canonicalPath = `/${encodeKeyPath(
      key === '' ? this.options.bucket : `${this.options.bucket}/${key}`,
    )}`;
    const query = opts.query ?? {};
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? '')}`)
      .join('&');

    const payloadHash = sha256HexOf(opts.body ?? Buffer.alloc(0));
    const headers: Record<string, string> = {
      host: this.base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
      ...Object.fromEntries(
        Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
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

    const url = new URL(this.base.origin);
    url.pathname = canonicalPath;
    url.search = canonicalQuery;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    return fetchImpl(url, {
      method,
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: opts.body ? new Uint8Array(opts.body) : undefined,
    });
  }

  async put(sha: string, bytes: Buffer): Promise<void> {
    const res = await this.request('PUT', this.keyFor(sha), {
      body: bytes,
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (!res.ok) throw new Error(`s3 put ${sha}: ${res.status} ${await res.text()}`);
  }

  async get(sha: string, range?: BlobRange): Promise<Buffer | null> {
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.start}-${range.end ?? ''}`;
    const res = await this.request('GET', this.keyFor(sha), { headers });
    if (res.status === 404) return null;
    if (!res.ok && res.status !== 206) {
      throw new Error(`s3 get ${sha}: ${res.status} ${await res.text()}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async has(sha: string): Promise<boolean> {
    return (await this.stat(sha)) !== null;
  }

  async delete(sha: string): Promise<void> {
    const res = await this.request('DELETE', this.keyFor(sha));
    // 404 is success for an idempotent delete.
    if (!res.ok && res.status !== 404) {
      throw new Error(`s3 delete ${sha}: ${res.status} ${await res.text()}`);
    }
  }

  async list(): Promise<string[]> {
    const prefix = this.keyFor('0'.repeat(64)).slice(0, -64); // ".../blobs/sha256/"
    const shas: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const res = await this.request('GET', '', { query });
      if (!res.ok) throw new Error(`s3 list: ${res.status} ${await res.text()}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
        const sha = (m[1] ?? '').slice(prefix.length);
        if (/^[0-9a-f]{64}$/.test(sha)) shas.push(sha);
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated
        ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
        : undefined;
    } while (token);
    return shas.sort();
  }

  async stat(sha: string): Promise<BlobStat | null> {
    const res = await this.request('HEAD', this.keyFor(sha));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 head ${sha}: ${res.status}`);
    const len = res.headers.get('content-length');
    return { size: len ? Number(len) : 0 };
  }
}
