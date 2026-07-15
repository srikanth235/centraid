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

import { assertSha, type BlobRange, type BlobStat, type BlobStore } from './store.js';
import { signS3Request } from './sigv4.js';

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
  /**
   * S3 storage class (issue #405 §6): sent as the `x-amz-storage-class`
   * header — SigV4-signed like every other header — on the two requests that
   * CREATE an object: the single `put()` PUT and multipart's
   * `CreateMultipartUpload`. Never sent on uploadPart/complete/get/head/
   * delete/list (S3 fixes an object's class at creation). Unset ⇒ header
   * absent ⇒ byte-identical to today's behavior. Deliberately un-validated
   * and free-form: S3-compatibles define their own class names (STANDARD_IA,
   * GLACIER, R2's single implicit class, and clawgnition may grow `derived`/
   * IA-style tiers per clawgnition#118), so this driver passes the string
   * through and lets the endpoint accept or reject it.
   */
  storageClass?: string;
  /**
   * Bounded-retry knobs (issue #405 §4) — a test seam. `retryAttempts` is
   * the TOTAL number of tries (default 3); `sleepImpl` backs the backoff
   * wait so tests can run instantly / assert the schedule. Both default to
   * production values; callers never set them outside tests.
   */
  retryAttempts?: number;
  sleepImpl?: (ms: number) => Promise<void>;
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

/** Retry defaults (issue #405 §4): 3 tries total, ~200ms→~2s jittered backoff. */
const RETRY_ATTEMPTS_DEFAULT = 3;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 2000;

export class S3BlobStore implements BlobStore {
  readonly kind = 's3';
  private readonly base: URL;
  private readonly throttle: TokenBucket | undefined;
  private readonly retryAttempts: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(private readonly options: S3BlobStoreOptions) {
    this.base = new URL(options.endpoint);
    this.throttle = options.throttleBytesPerSec
      ? new TokenBucket(options.throttleBytesPerSec)
      : undefined;
    this.retryAttempts = Math.max(1, options.retryAttempts ?? RETRY_ATTEMPTS_DEFAULT);
    this.sleepImpl = options.sleepImpl ?? delay;
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
    // Path-style addressing (`/bucket/key`) — the '' key is the bucket root
    // (ListObjectsV2). SigV4 signing lives in sigv4.ts (issue #405 §4 split).
    const signed = signS3Request({
      method,
      base: this.base,
      path: key === '' ? this.options.bucket : `${this.options.bucket}/${key}`,
      region: this.options.region ?? 'us-east-1',
      credentials: creds,
      ...(opts.body ? { body: opts.body } : {}),
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.query ? { query: opts.query } : {}),
    });
    const fetchImpl = this.options.fetchImpl ?? fetch;
    return fetchImpl(signed.url, {
      method,
      headers: signed.headers,
      body: opts.body ? new Uint8Array(opts.body) : undefined,
    });
  }

  /**
   * `request()` with bounded retry (issue #405 §4). Today a single transient
   * fault — one 503 from the endpoint, one dropped socket — fails a whole
   * reconciliation sweep or restore. This retries the RETRYABLE faults:
   *
   *   - a thrown fetch/network error (connection refused, socket destroyed);
   *   - HTTP 429 (throttled) and any 5xx (server-side transient).
   *
   * Every other status — 2xx, 3xx, and 4xx OTHER than 429 (incl. 404, which
   * callers read as "absent") — is a definitive answer and returns
   * immediately: retrying a 400/403 only burns budget on a request the
   * endpoint will keep rejecting. Backoff is exponential with full jitter
   * (base→cap), so a fleet of stores doesn't resynchronize its retries.
   *
   * Idempotency, per op that routes through here:
   *   - get / stat(HEAD) / list — pure reads, trivially safe to repeat.
   *   - put — content-addressed: a retried PUT overwrites the same key with
   *     byte-identical bytes (same sha), so at-most/at-least-once collapse.
   *   - delete — idempotent by design (404 counts as success upstream).
   *   - uploadPart — keyed by (uploadId, partNumber); a retry overwrites the
   *     same part, and we keep the ETag from the try that actually returned.
   *   - createMultipartUpload — the one NON-idempotent op: if a create
   *     SUCCEEDED server-side but its response was lost, the retry mints a
   *     SECOND uploadId and the first is orphaned. That orphan is bounded and
   *     swept — putStream aborts on any later failure, and a bucket lifecycle
   *     rule reaps incomplete multipart uploads — which is strictly better
   *     than failing the entire sweep on a single transient 503.
   *   - completeMultipartUpload — the parts list is fixed for the call, so a
   *     retry re-submits the same manifest; completing an already-completed
   *     upload is the endpoint's call to accept or 4xx (not retried).
   *
   * Throttle budget is consumed by callers BEFORE this wrapper (see `put` /
   * `uploadPart`), so retried bytes are NOT re-charged against the token
   * bucket — a retry re-sends the body but the pacing already accounted for
   * it once, which is the conservative (never over-throttles) choice.
   */
  private async send(
    method: string,
    key: string,
    opts: { body?: Buffer; headers?: Record<string, string>; query?: Record<string, string> } = {},
  ): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      const last = attempt === this.retryAttempts;
      let res: Response;
      try {
        res = await this.request(method, key, opts);
      } catch (err) {
        // A fetch/network fault never reached the server — always retryable.
        lastErr = err;
        if (last) throw err;
        await this.backoff(attempt);
        continue;
      }
      if (!last && (res.status === 429 || res.status >= 500)) {
        // Drain the body so the underlying socket can be reused (keep-alive),
        // then back off. The caller never sees this response.
        await res.text().catch(() => undefined);
        await this.backoff(attempt);
        continue;
      }
      // Definitive answer (incl. a 5xx on the final try) — hand it back so the
      // caller applies its own ok/404/206 logic and surfaces the status.
      return res;
    }
    // Unreachable: the loop either returns a Response or throws above.
    throw lastErr ?? new Error(`s3 ${method} ${key}: retries exhausted`);
  }

  /** Exponential backoff with full jitter (issue #405 §4), injectable sleep. */
  private async backoff(attempt: number): Promise<void> {
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    await this.sleepImpl(Math.random() * ceiling);
  }

  async put(sha: string, bytes: Buffer): Promise<void> {
    if (this.throttle) await this.throttle.consume(bytes.length);
    const res = await this.send('PUT', this.keyFor(sha), {
      body: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        // Storage class rides the object-creating PUT (issue #405 §6); the
        // signer folds it into SignedHeaders like any other header.
        ...(this.options.storageClass ? { 'x-amz-storage-class': this.options.storageClass } : {}),
      },
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
    const res = await this.send('POST', key, {
      query: { uploads: '' },
      // The multipart twin of `put`'s storage class (issue #405 §6): S3 fixes
      // the class at CreateMultipartUpload, so it goes here and nowhere else
      // in the multipart dance (uploadPart/complete never carry it).
      ...(this.options.storageClass
        ? { headers: { 'x-amz-storage-class': this.options.storageClass } }
        : {}),
    });
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
    const res = await this.send('PUT', key, {
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
    const res = await this.send('POST', key, { body, query: { uploadId } });
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
    const res = await this.send('GET', this.keyFor(sha), { headers });
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
    const res = await this.send('DELETE', this.keyFor(sha));
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
      const res = await this.send('GET', '', { query });
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
    const res = await this.send('HEAD', this.keyFor(sha));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 head ${sha}: ${res.status}`);
    const len = res.headers.get('content-length');
    return { size: len ? Number(len) : 0 };
  }
}
