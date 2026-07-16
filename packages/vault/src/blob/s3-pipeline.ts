/* eslint-disable max-classes-per-file -- token bucket is an implementation detail of the shared S3 pipeline (#418) */
import { signS3Request } from './sigv4.js';
import type { S3BlobStoreOptions } from './s3.js';

export interface S3RequestInput {
  body?: Buffer;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface S3MultipartPart {
  partNumber: number;
  etag: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class TokenBucket {
  private tokens: number;
  private lastRefillMs = Date.now();

  constructor(private readonly ratePerSec: number) {
    this.tokens = ratePerSec;
  }

  async consume(bytes: number): Promise<void> {
    if (this.ratePerSec <= 0 || bytes <= 0) return;
    for (;;) {
      const now = Date.now();
      const elapsedSec = (now - this.lastRefillMs) / 1000;
      this.lastRefillMs = now;
      this.tokens = Math.min(this.ratePerSec, this.tokens + elapsedSec * this.ratePerSec);
      if (this.tokens >= bytes || bytes >= this.ratePerSec) {
        this.tokens = Math.max(0, this.tokens - bytes);
        return;
      }
      await delay(Math.min(Math.max(((bytes - this.tokens) / this.ratePerSec) * 1000, 10), 1000));
    }
  }
}

/** Shared signed request, retry, pacing, and multipart pipeline for every S3 surface. */
export class S3RequestPipeline {
  private readonly base: URL;
  private readonly throttle: TokenBucket | undefined;
  private readonly tries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: S3BlobStoreOptions) {
    this.base = new URL(options.endpoint);
    this.throttle = options.throttleBytesPerSec
      ? new TokenBucket(options.throttleBytesPerSec)
      : undefined;
    this.tries = Math.max(1, options.retryAttempts ?? 3);
    this.sleep = options.sleepImpl ?? delay;
  }

  pace(bytes: number): Promise<void> {
    return this.throttle?.consume(bytes) ?? Promise.resolve();
  }

  async request(method: string, key: string, input: S3RequestInput = {}): Promise<Response> {
    const credentials = await this.options.credentials();
    const signed = signS3Request({
      method,
      base: this.base,
      path: key === '' ? this.options.bucket : `${this.options.bucket}/${key}`,
      region: this.options.region ?? 'us-east-1',
      credentials,
      ...(input.body ? { body: input.body } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
    });
    return (this.options.fetchImpl ?? fetch)(signed.url, {
      method,
      headers: signed.headers,
      body: input.body ? new Uint8Array(input.body) : undefined,
    });
  }

  async send(method: string, key: string, input: S3RequestInput = {}): Promise<Response> {
    let failure: unknown;
    for (let attempt = 1; attempt <= this.tries; attempt += 1) {
      try {
        const response = await this.request(method, key, input);
        if (attempt === this.tries || (response.status !== 429 && response.status < 500)) {
          return response;
        }
        await response.text().catch(() => undefined);
      } catch (error) {
        failure = error;
        if (attempt === this.tries) throw error;
      }
      const ceiling = Math.min(2_000, 200 * 2 ** (attempt - 1));
      await this.sleep(Math.random() * ceiling);
    }
    throw failure ?? new Error(`S3 ${method} retries exhausted`);
  }

  async beginMultipart(key: string, headers?: Record<string, string>): Promise<string> {
    const response = await this.send('POST', key, {
      query: { uploads: '' },
      ...(headers ? { headers } : {}),
    });
    if (!response.ok) throw new Error(`s3 create multipart upload: ${response.status}`);
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await response.text())?.[1];
    if (!uploadId) throw new Error('s3 create multipart upload: missing UploadId');
    return uploadId;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    await this.pace(body.length);
    const response = await this.send('PUT', key, {
      body,
      query: { partNumber: String(partNumber), uploadId },
    });
    if (!response.ok) throw new Error(`s3 upload part ${partNumber}: ${response.status}`);
    return response.headers.get('etag') ?? `"part-${partNumber}"`;
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly S3MultipartPart[],
  ): Promise<void> {
    const body = Buffer.from(
      `<CompleteMultipartUpload>${parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`,
        )
        .join('')}</CompleteMultipartUpload>`,
    );
    const response = await this.send('POST', key, { body, query: { uploadId } });
    if (!response.ok) throw new Error(`s3 complete multipart upload: ${response.status}`);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const response = await this.request('DELETE', key, { query: { uploadId } });
    if (!response.ok && response.status !== 404) {
      throw new Error(`s3 abort multipart upload: ${response.status}`);
    }
  }
}
