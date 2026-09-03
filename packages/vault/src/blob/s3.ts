import { S3RequestPipeline } from "./s3-pipeline.js";
import { assertSha } from "./store.js";
import type { BlobRange, BlobStat, BlobStore } from "./store.js";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3BlobStoreOptions {
  endpoint: string;
  bucket: string;
  region?: string;
  prefix?: string;
  credentials: () => Promise<S3Credentials>;
  fetchImpl?: typeof fetch;
  throttleBytesPerSec?: number;
  storageClass?: string;
  retryAttempts?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

export const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;

async function streamToBuffer(source: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function* chunkReadable(
  source: NodeJS.ReadableStream,
  partSize: number
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

export class S3BlobStore implements BlobStore {
  readonly kind = "s3";
  private readonly pipeline: S3RequestPipeline;

  constructor(private readonly options: S3BlobStoreOptions) {
    this.pipeline = new S3RequestPipeline(options);
  }

  private keyFor(sha: string): string {
    assertSha(sha);
    const prefix = this.options.prefix
      ? this.options.prefix.replace(/\/+$/u, "") + "/"
      : "";
    return `${prefix}blobs/sha256/${sha}`;
  }

  private async request(
    method: string,
    key: string,
    opts: {
      body?: Buffer;
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {}
  ): Promise<Response> {
    return this.pipeline.request(method, key, opts);
  }

  private async send(
    method: string,
    key: string,
    opts: {
      body?: Buffer;
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {}
  ): Promise<Response> {
    return this.pipeline.send(method, key, opts);
  }

  private classOf(override?: string): string | undefined {
    return override ?? this.options.storageClass;
  }

  async put(sha: string, bytes: Buffer, storageClass?: string): Promise<void> {
    await this.pipeline.pace(bytes.length);
    const cls = this.classOf(storageClass);
    const res = await this.send("PUT", this.keyFor(sha), {
      body: bytes,
      headers: {
        "content-type": "application/octet-stream",
        ...(cls ? { "x-amz-storage-class": cls } : {}),
      },
    });
    if (!res.ok)
      throw new Error(`s3 put ${sha}: ${res.status} ${await res.text()}`);
  }

  async putStream(
    sha: string,
    source: NodeJS.ReadableStream,
    approxSize: number,
    storageClass?: string
  ): Promise<void> {
    const key = this.keyFor(sha);
    if (approxSize <= MULTIPART_THRESHOLD_BYTES) {
      return this.put(sha, await streamToBuffer(source), storageClass);
    }
    const uploadId = await this.createMultipartUpload(key, storageClass);
    try {
      const parts: { partNumber: number; etag: string }[] = [];
      let partNumber = 1;
      for await (const chunk of chunkReadable(
        source,
        MULTIPART_PART_SIZE_BYTES
      )) {
        const etag = await this.uploadPart(key, uploadId, partNumber, chunk);
        parts.push({ partNumber, etag });
        partNumber += 1;
      }
      if (parts.length === 0) {
        await this.abortMultipartUpload(key, uploadId);
        await this.put(sha, Buffer.alloc(0));
        return;
      }
      await this.completeMultipartUpload(key, uploadId, parts);
    } catch (error) {
      await this.abortMultipartUpload(key, uploadId).catch(() => undefined);
      throw error;
    }
  }

  private async createMultipartUpload(
    key: string,
    storageClass?: string
  ): Promise<string> {
    const cls = this.classOf(storageClass);
    return this.pipeline.beginMultipart(
      key,
      cls ? { "x-amz-storage-class": cls } : undefined
    );
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer
  ): Promise<string> {
    return this.pipeline.uploadPart(key, uploadId, partNumber, body);
  }

  private async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[]
  ): Promise<void> {
    await this.pipeline.completeMultipart(key, uploadId, parts);
  }

  private async abortMultipartUpload(
    key: string,
    uploadId: string
  ): Promise<void> {
    await this.pipeline.abortMultipart(key, uploadId);
  }

  async get(sha: string, range?: BlobRange): Promise<Buffer | null> {
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.start}-${range.end ?? ""}`;
    const res = await this.send("GET", this.keyFor(sha), { headers });
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
    const res = await this.send("DELETE", this.keyFor(sha));
    if (!res.ok && res.status !== 404) {
      throw new Error(`s3 delete ${sha}: ${res.status} ${await res.text()}`);
    }
  }

  async list(): Promise<string[]> {
    const prefix = this.keyFor("0".repeat(64)).slice(0, -64); // ".../blobs/sha256/"
    const shas: string[] = [];
    const listPage = async (token?: string): Promise<void> => {
      const query: Record<string, string> = {
        "list-type": "2",
        prefix,
        "max-keys": "1000",
      };
      if (token) query["continuation-token"] = token;
      const res = await this.send("GET", "", { query });
      if (!res.ok)
        throw new Error(`s3 list: ${res.status} ${await res.text()}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>(?<key>[^<]+)<\/Key>/gu)) {
        const sha = (m.groups?.key ?? "").slice(prefix.length);
        if (/^[0-9a-f]{64}$/u.test(sha)) shas.push(sha);
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/u.test(xml);
      const tokenMatch =
        /<NextContinuationToken>(?<token>[^<]+)<\/NextContinuationToken>/u.exec(
          xml
        );
      const nextToken = truncated ? tokenMatch?.groups?.token : undefined;
      if (nextToken) return listPage(nextToken);
    };
    await listPage();
    return shas.sort();
  }

  async stat(sha: string): Promise<BlobStat | null> {
    const res = await this.send("HEAD", this.keyFor(sha));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 head ${sha}: ${res.status}`);
    const len = res.headers.get("content-length");
    return { size: len ? Number(len) : 0 };
  }
}
