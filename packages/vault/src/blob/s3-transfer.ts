// Restartable/direct S3 transfer surface (issue #414). Kept out of s3.ts so
// the ordinary CAS driver remains below the repository's 500-line ceiling.

import { assertSha, type BlobRange, type BlobStat } from './store.js';
import { encodeKeyPath, presignS3Request, signS3Request } from './sigv4.js';
import type { S3BlobStoreOptions } from './s3.js';
import type {
  MultipartPart,
  RemoteBlobTransfer,
  TemporaryMultipartUpload,
} from './remote-transfer.js';

const PART_BYTES = 16 * 1024 * 1024;
const MULTIPART_AT = 32 * 1024 * 1024;
const TEMP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function* chunks(source: NodeJS.ReadableStream, size = PART_BYTES): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let length = 0;
  for await (const value of source as AsyncIterable<Buffer | string>) {
    let next = Buffer.isBuffer(value) ? value : Buffer.from(value);
    while (next.length > 0) {
      const take = next.subarray(0, Math.min(size - length, next.length));
      pending.push(take);
      length += take.length;
      next = next.subarray(take.length);
      if (length === size) {
        yield Buffer.concat(pending, length);
        pending = [];
        length = 0;
      }
    }
  }
  if (length > 0) yield Buffer.concat(pending, length);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function xmlValue(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
}

export class S3TransferStore implements RemoteBlobTransfer {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private nextUploadAt = 0;

  constructor(private readonly options: S3BlobStoreOptions) {
    this.base = new URL(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private prefix(): string {
    return this.options.prefix ? this.options.prefix.replace(/\/+$/, '') + '/' : '';
  }

  private shaKey(sha: string): string {
    return `${this.prefix()}blobs/sha256/${assertSha(sha)}`;
  }

  private tempKey(tempId: string): string {
    if (!TEMP_ID.test(tempId)) throw new Error(`invalid blob transfer temp id: ${tempId}`);
    return `${this.prefix()}tmp/blobs/${tempId}`;
  }

  private async pace(bytes: number): Promise<void> {
    const rate = this.options.throttleBytesPerSec;
    if (!rate || rate <= 0 || bytes <= 0) return;
    const now = Date.now();
    const start = Math.max(now, this.nextUploadAt);
    this.nextUploadAt = start + Math.ceil((bytes / rate) * 1000);
    if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
  }

  private async request(
    method: string,
    key: string,
    input: { body?: Buffer; query?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<Response> {
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
    return this.fetchImpl(signed.url, {
      method,
      headers: signed.headers,
      body: input.body ? new Uint8Array(input.body) : undefined,
    });
  }

  private async send(
    method: string,
    key: string,
    input: { body?: Buffer; query?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const tries = Math.max(1, this.options.retryAttempts ?? 3);
    let failure: unknown;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try {
        const response = await this.request(method, key, input);
        if (attempt === tries || (response.status !== 429 && response.status < 500))
          return response;
        await response.text().catch(() => undefined);
      } catch (error) {
        failure = error;
        if (attempt === tries) throw error;
      }
      await (this.options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
        Math.min(2_000, 200 * 2 ** (attempt - 1)),
      );
    }
    throw failure ?? new Error(`S3 ${method} retries exhausted`);
  }

  private async beginMultipart(key: string, label: string): Promise<string> {
    const response = await this.send('POST', key, {
      query: { uploads: '' },
      ...(this.options.storageClass
        ? { headers: { 'x-amz-storage-class': this.options.storageClass } }
        : {}),
    });
    if (!response.ok) throw new Error(`s3 begin ${label} upload: ${response.status}`);
    const body = await response.text();
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(body)?.[1];
    if (!uploadId) throw new Error(`s3 begin ${label} upload: missing UploadId`);
    return uploadId;
  }

  private async uploadPart(
    key: string,
    label: string,
    uploadId: string,
    partNumber: number,
    bytes: Buffer,
  ): Promise<string> {
    await this.pace(bytes.length);
    const response = await this.send('PUT', key, {
      body: bytes,
      query: { partNumber: String(partNumber), uploadId },
    });
    if (!response.ok) throw new Error(`s3 upload ${label} part ${partNumber}: ${response.status}`);
    return response.headers.get('etag') ?? `"part-${partNumber}"`;
  }

  private async completeMultipart(
    key: string,
    label: string,
    uploadId: string,
    parts: readonly MultipartPart[],
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
    if (!response.ok) throw new Error(`s3 complete ${label} upload: ${response.status}`);
  }

  private async abortMultipart(key: string, label: string, uploadId: string): Promise<void> {
    const response = await this.request('DELETE', key, { query: { uploadId } });
    if (!response.ok && response.status !== 404) {
      throw new Error(`s3 abort ${label} upload: ${response.status}`);
    }
  }

  beginShaUpload(sha: string): Promise<string> {
    return this.beginMultipart(this.shaKey(sha), 'final SHA');
  }

  uploadShaPart(sha: string, uploadId: string, partNumber: number, bytes: Buffer): Promise<string> {
    return this.uploadPart(this.shaKey(sha), 'final SHA', uploadId, partNumber, bytes);
  }

  completeShaUpload(sha: string, uploadId: string, parts: readonly MultipartPart[]): Promise<void> {
    return this.completeMultipart(this.shaKey(sha), 'final SHA', uploadId, parts);
  }

  abortShaUpload(sha: string, uploadId: string): Promise<void> {
    return this.abortMultipart(this.shaKey(sha), 'final SHA', uploadId);
  }

  async beginTemporaryUpload(tempId: string): Promise<string> {
    return this.beginMultipart(this.tempKey(tempId), 'temporary');
  }

  async uploadTemporaryPart(
    tempId: string,
    uploadId: string,
    partNumber: number,
    bytes: Buffer,
  ): Promise<string> {
    return this.uploadPart(this.tempKey(tempId), 'temporary', uploadId, partNumber, bytes);
  }

  async completeTemporaryUpload(
    tempId: string,
    uploadId: string,
    parts: readonly MultipartPart[],
  ): Promise<void> {
    return this.completeMultipart(this.tempKey(tempId), 'temporary', uploadId, parts);
  }

  async abortTemporaryUpload(tempId: string, uploadId: string): Promise<void> {
    return this.abortMultipart(this.tempKey(tempId), 'temporary', uploadId);
  }

  async listTemporaryUploads(): Promise<TemporaryMultipartUpload[]> {
    const prefix = `${this.prefix()}tmp/blobs/`;
    const uploads: TemporaryMultipartUpload[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (;;) {
      const query: Record<string, string> = {
        uploads: '',
        prefix,
        'encoding-type': 'url',
        'max-uploads': '1000',
      };
      if (keyMarker) query['key-marker'] = keyMarker;
      if (uploadIdMarker) query['upload-id-marker'] = uploadIdMarker;
      const response = await this.send('GET', '', { query });
      if (!response.ok) throw new Error(`s3 list temporary uploads: ${response.status}`);
      const xml = await response.text();
      for (const match of xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
        const block = match[1] ?? '';
        const rawKey = xmlValue(block, 'Key');
        const rawUploadId = xmlValue(block, 'UploadId');
        const rawInitiated = xmlValue(block, 'Initiated');
        if (rawKey === undefined || !rawUploadId || !rawInitiated) continue;
        let key: string;
        try {
          key = decodeURIComponent(xmlUnescape(rawKey));
        } catch {
          continue;
        }
        const tempId = key.startsWith(prefix) ? key.slice(prefix.length) : '';
        if (!TEMP_ID.test(tempId)) continue;
        uploads.push({
          tempId,
          uploadId: xmlUnescape(rawUploadId),
          initiatedAt: xmlUnescape(rawInitiated),
        });
      }
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
      const nextKey = xmlValue(xml, 'NextKeyMarker');
      const nextUploadId = xmlValue(xml, 'NextUploadIdMarker');
      if (!nextKey || (nextKey === keyMarker && nextUploadId === uploadIdMarker)) {
        throw new Error('s3 list temporary uploads: invalid pagination markers');
      }
      keyMarker = decodeURIComponent(xmlUnescape(nextKey));
      uploadIdMarker = nextUploadId ? xmlUnescape(nextUploadId) : undefined;
    }
    return uploads;
  }

  async putTemporary(tempId: string, bytes: Buffer): Promise<void> {
    await this.pace(bytes.length);
    const response = await this.send('PUT', this.tempKey(tempId), {
      body: bytes,
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (!response.ok) throw new Error(`s3 put temporary: ${response.status}`);
  }

  async putTemporaryStream(
    tempId: string,
    source: NodeJS.ReadableStream,
    approxSize: number,
  ): Promise<void> {
    if (approxSize <= MULTIPART_AT) {
      const all: Buffer[] = [];
      for await (const value of source as AsyncIterable<Buffer | string>) {
        all.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
      }
      return this.putTemporary(tempId, Buffer.concat(all));
    }
    const uploadId = await this.beginTemporaryUpload(tempId);
    try {
      const parts: MultipartPart[] = [];
      let partNumber = 1;
      for await (const bytes of chunks(source)) {
        parts.push({
          partNumber,
          etag: await this.uploadTemporaryPart(tempId, uploadId, partNumber, bytes),
        });
        partNumber += 1;
      }
      await this.completeTemporaryUpload(tempId, uploadId, parts);
    } catch (error) {
      await this.abortTemporaryUpload(tempId, uploadId).catch(() => undefined);
      throw error;
    }
  }

  async statTemporary(tempId: string): Promise<BlobStat | null> {
    const response = await this.send('HEAD', this.tempKey(tempId));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`s3 head temporary: ${response.status}`);
    return { size: Number(response.headers.get('content-length') ?? 0) };
  }

  async getTemporary(tempId: string, range?: BlobRange): Promise<Buffer | null> {
    const headers: Record<string, string> = {};
    if (range) headers['range'] = `bytes=${range.start}-${range.end ?? ''}`;
    const response = await this.send('GET', this.tempKey(tempId), { headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`s3 get temporary: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async copyTemporaryToSha(tempId: string, sha: string): Promise<void> {
    const source = `/${this.options.bucket}/${encodeKeyPath(this.tempKey(tempId))}`;
    const response = await this.send('PUT', this.shaKey(sha), {
      headers: {
        'x-amz-copy-source': source,
        ...(this.options.storageClass ? { 'x-amz-storage-class': this.options.storageClass } : {}),
      },
    });
    if (!response.ok) throw new Error(`s3 promote temporary blob: ${response.status}`);
  }

  async deleteTemporary(tempId: string): Promise<void> {
    const response = await this.send('DELETE', this.tempKey(tempId));
    if (!response.ok && response.status !== 404)
      throw new Error(`s3 delete temporary: ${response.status}`);
  }

  private async presign(
    method: 'GET' | 'PUT',
    key: string,
    query: Record<string, string> | undefined,
    expiresSeconds: number | undefined,
  ): Promise<URL> {
    return presignS3Request({
      method,
      base: this.base,
      path: `${this.options.bucket}/${key}`,
      region: this.options.region ?? 'us-east-1',
      credentials: await this.options.credentials(),
      ...(query ? { query } : {}),
      ...(expiresSeconds ? { expiresSeconds } : {}),
    });
  }

  presignTemporaryPut(tempId: string, expiresSeconds?: number): Promise<URL> {
    return this.presign('PUT', this.tempKey(tempId), undefined, expiresSeconds);
  }

  presignTemporaryPart(
    tempId: string,
    uploadId: string,
    partNumber: number,
    expiresSeconds?: number,
  ): Promise<URL> {
    return this.presign(
      'PUT',
      this.tempKey(tempId),
      { partNumber: String(partNumber), uploadId },
      expiresSeconds,
    );
  }

  presignShaGet(sha: string, expiresSeconds?: number): Promise<URL> {
    return this.presign('GET', this.shaKey(sha), undefined, expiresSeconds);
  }
}
