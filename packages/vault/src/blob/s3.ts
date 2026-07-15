/* eslint-disable max-classes-per-file -- throttle and S3 driver share one request pipeline (#408) */
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
  /**
   * Upload rate cap, bytes/sec (issue #367 §C7) — a simple token bucket
   * applied before every PUT / multipart UploadPart. Omitted/0 = unthrottled.
   * Downloads (`get`) are never throttled — only the replication path this
   * store's writes serve needs pacing against the owner's uplink.
   */
  throttleBytesPerSec?: number;
}

/** Bodies over this size use multipart upload (issue #367 §C8) instead of one PUT. */
export const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
/** Multipart part size — S3's own minimum is 5 MiB; this bounds streaming memory to roughly one part. */
const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A plain token bucket: refills continuously at `ratePerSec`, `consume`
 * blocks until enough tokens exist (or the request is bigger than the whole
 * per-second budget, in which case it drains what's there and proceeds —
 * this paces sustained throughput, it isn't a hard per-call cap).
 */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(private readonly ratePerSec: number) {
    this.tokens = ratePerSec;
    this.lastRefillMs = Date.now();
  }

  async consume(bytes: number): Promise<void> {
    if (this.ratePerSec <= 0 || bytes <= 0) return;
    for (;;) {
      this.refill();
      if (this.tokens >= bytes || bytes >= this.ratePerSec) {
        this.tokens = Math.max(0, this.tokens - bytes);
        return;
      }
      const waitMs = ((bytes - this.tokens) / this.ratePerSec) * 1000;
      await delay(Math.min(Math.max(waitMs, 10), 1000));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    this.lastRefillMs = now;
    this.tokens = Math.min(this.ratePerSec, this.tokens + elapsedSec * this.ratePerSec);
  }
}

async function streamToBuffer(source: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Re-chunk a Readable into fixed-size Buffers, bounding resident memory to
 * roughly one part size regardless of the source's total length (issue #367
 * §C8: "never materializing the whole blob in memory").
 * @yields Fixed-size upload parts, with one final short part when needed.
 */
async function* chunkReadable(
  source: NodeJS.ReadableStream,
  partSize: number,
): AsyncGenerator<Buffer> {
  let buffered: Buffer[] = [];
  let bufferedLen = 0;
  for await (const raw of source as AsyncIterable<Buffer | string>) {
    let chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    while (chunk.length > 0) {
      const need = partSize - bufferedLen;
      const take = chunk.subarray(0, Math.min(need, chunk.length));
      buffered.push(take);
      bufferedLen += take.length;
      chunk = chunk.subarray(take.length);
      if (bufferedLen >= partSize) {
        yield Buffer.concat(buffered, bufferedLen);
        buffered = [];
        bufferedLen = 0;
      }
    }
  }
  if (bufferedLen > 0) yield Buffer.concat(buffered, bufferedLen);
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
  private readonly throttle: TokenBucket | undefined;

  constructor(private readonly options: S3BlobStoreOptions) {
    this.base = new URL(options.endpoint);
    this.throttle = options.throttleBytesPerSec
      ? new TokenBucket(options.throttleBytesPerSec)
      : undefined;
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
    if (this.throttle) await this.throttle.consume(bytes.length);
    const res = await this.request('PUT', this.keyFor(sha), {
      body: bytes,
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (!res.ok) throw new Error(`s3 put ${sha}: ${res.status} ${await res.text()}`);
  }

  /**
   * Streaming upload (issue #367 §C8): bodies at or under
   * `MULTIPART_THRESHOLD_BYTES` buffer whole (bounded, same as `put`);
   * larger ones go through S3 multipart upload, streamed from `source` in
   * `MULTIPART_PART_SIZE_BYTES` chunks — at most one part resident in memory
   * at a time, never the whole blob. Aborts the multipart upload on any
   * failure so a partial upload doesn't bill/linger.
   */
  async putStream(sha: string, source: NodeJS.ReadableStream, approxSize: number): Promise<void> {
    const key = this.keyFor(sha);
    if (approxSize <= MULTIPART_THRESHOLD_BYTES) {
      return this.put(sha, await streamToBuffer(source));
    }
    const uploadId = await this.createMultipartUpload(key);
    try {
      const parts: { partNumber: number; etag: string }[] = [];
      let partNumber = 1;
      for await (const chunk of chunkReadable(source, MULTIPART_PART_SIZE_BYTES)) {
        const etag = await this.uploadPart(key, uploadId, partNumber, chunk);
        parts.push({ partNumber, etag });
        partNumber += 1;
      }
      if (parts.length === 0) {
        // An empty stream — S3 refuses a zero-part complete. Abort and fall
        // back to a trivial single PUT (a 0-byte blob is a degenerate case,
        // not a multipart one).
        await this.abortMultipartUpload(key, uploadId);
        await this.put(sha, Buffer.alloc(0));
        return;
      }
      await this.completeMultipartUpload(key, uploadId, parts);
    } catch (err) {
      await this.abortMultipartUpload(key, uploadId).catch(() => undefined);
      throw err;
    }
  }

  private async createMultipartUpload(key: string): Promise<string> {
    const res = await this.request('POST', key, { query: { uploads: '' } });
    if (!res.ok) {
      throw new Error(`s3 create-multipart-upload: ${res.status} ${await res.text()}`);
    }
    const xml = await res.text();
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
    if (!uploadId) throw new Error('s3 create-multipart-upload: response carried no UploadId');
    return uploadId;
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    if (this.throttle) await this.throttle.consume(body.length);
    const res = await this.request('PUT', key, {
      body,
      query: { partNumber: String(partNumber), uploadId },
    });
    if (!res.ok) {
      throw new Error(`s3 upload-part ${partNumber}: ${res.status} ${await res.text()}`);
    }
    // Some path-style test doubles don't echo an ETag — fall back to a
    // synthetic one keyed by part number so `completeMultipartUpload`'s XML
    // still has *something* per part (real S3 always sets this header).
    return res.headers.get('etag') ?? `"part-${partNumber}"`;
  }

  private async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<void> {
    const body = Buffer.from(
      `<CompleteMultipartUpload>${parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
        .join('')}</CompleteMultipartUpload>`,
      'utf8',
    );
    const res = await this.request('POST', key, { body, query: { uploadId } });
    if (!res.ok) {
      throw new Error(`s3 complete-multipart-upload: ${res.status} ${await res.text()}`);
    }
  }

  private async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const res = await this.request('DELETE', key, { query: { uploadId } });
    if (!res.ok && res.status !== 404) {
      throw new Error(`s3 abort-multipart-upload: ${res.status} ${await res.text()}`);
    }
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
