/*
 * A reusable, crude path-style S3-compatible test server: PUT/GET/HEAD/
 * DELETE object, GET bucket = ListObjectsV2 (paginated). Test-only — this
 * module is intentionally NOT re-exported from `index.ts` (see README's
 * "public API" convention); it exists purely so the package's own tests, and
 * anything that wants to point a real S3-credentialed client at *something*,
 * share one implementation instead of two copies drifting apart.
 *
 * Two consumers as of writing:
 *  - `remote-provider.test.ts`'s in-process fake gateway, which serves the
 *    control plane itself and delegates data-plane requests to an instance
 *    of this server.
 *  - `interop-clawgnition.test.ts`, which points a REAL Clawgnition
 *    `wrangler dev` gateway's S3 credential grants (the `DEV_BACKUP_S3_*`
 *    dev fallback — see Clawgnition's docs/LOCAL_DEV_BACKUP.md) at this
 *    server, playing the role R2 plays in production.
 *
 * SigV4 is NOT validated here — only its *presence* is observable via
 * `requests` (method/path/headers), which is enough for tests asserting the
 * client shapes Authorization/x-amz-* headers correctly. Real signature
 * verification is out of scope: this plays the role of "some S3-compatible
 * bucket," not a security boundary.
 */

import http from 'node:http';

export interface S3TestServerRequest {
  method: string;
  /** Path + query string, e.g. `/bucket/chunks/abcd?list-type=2`. */
  path: string;
  headers: http.IncomingHttpHeaders;
}

export interface S3TestServerOptions {
  /** Bind port. 0 (default) = OS-assigned ephemeral port. */
  port?: number;
  /** Bind host. Defaults to `127.0.0.1`. */
  host?: string;
  /**
   * ListObjectsV2 page size. Small values exercise pagination in tests;
   * defaults to 1000 (roughly S3's own default), which for most tests means
   * "one page."
   */
  listPageSize?: number;
}

/**
 * Crude path-style S3: object keys are the full `{bucket}/{key...}` path
 * (matching how `S3ObjectStore` addresses objects — see `s3-store.ts`).
 * Durable for the lifetime of the process holding the instance — a plain
 * in-memory `Map`, fine for "an in-process fake" or "a local dev-loop
 * stand-in," not for anything that needs to survive a restart.
 */
export class S3TestServer {
  readonly url: string;
  readonly port: number;
  /** Every request this server has handled (data-plane traffic only), in order. */
  readonly requests: S3TestServerRequest[] = [];

  private readonly objects = new Map<string, Buffer>();
  private readonly server: http.Server;
  private readonly listPageSize: number;
  /** In-flight multipart uploads (issue #367 §C8), keyed by uploadId. */
  private readonly multipart = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  private nextUploadId = 1;

  private constructor(server: http.Server, port: number, listPageSize: number) {
    this.server = server;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.listPageSize = listPageSize;
  }

  static async start(options: S3TestServerOptions = {}): Promise<S3TestServer> {
    const listPageSize = options.listPageSize ?? 1000;
    const host = options.host ?? '127.0.0.1';
    // The request handler needs `self` to call instance methods, but `self`
    // doesn't exist until after the constructor runs (which needs the
    // already-listening server's assigned port) — tie the knot with a
    // pre-declared binding the closure captures by reference.
    let self: S3TestServer;
    const server = http.createServer((req, res) => {
      self.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(err instanceof Error ? err.message : String(err));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, host, () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('S3TestServer: failed to bind a TCP port');
    }
    self = new S3TestServer(server, address.port, listPageSize);
    return self;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /** Clears captured requests without touching stored objects. */
  clearRequests(): void {
    this.requests.length = 0;
  }

  // --- Test-only direct object access — bypasses HTTP + SigV4 entirely, for
  // asserting/seeding/corrupting state the way a test double for "the real
  // bucket, poked at directly" needs to (e.g. simulating real data loss). ---

  private static compositeKey(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  hasObjectDirect(bucket: string, key: string): boolean {
    return this.objects.has(S3TestServer.compositeKey(bucket, key));
  }

  getObjectDirect(bucket: string, key: string): Buffer | undefined {
    return this.objects.get(S3TestServer.compositeKey(bucket, key));
  }

  putObjectDirect(bucket: string, key: string, data: Buffer): void {
    this.objects.set(S3TestServer.compositeKey(bucket, key), data);
  }

  deleteObjectDirect(bucket: string, key: string): boolean {
    return this.objects.delete(S3TestServer.compositeKey(bucket, key));
  }

  /** Every stored key under `bucket/prefix`, with the `bucket/` stripped. */
  listDirect(bucket: string, prefix = ''): string[] {
    const bucketPrefix = `${bucket}/`;
    const fullPrefix = `${bucketPrefix}${prefix}`;
    return [...this.objects.keys()]
      .filter((k) => k.startsWith(fullPrefix))
      .map((k) => k.slice(bucketPrefix.length))
      .sort();
  }

  // --- HTTP handling ---

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    this.requests.push({
      method: req.method ?? '',
      path: url.pathname + url.search,
      headers: req.headers,
    });

    // "{bucket}/{key...}" or bare "{bucket}" (listing/bucket-root requests).
    const key = decodeURIComponent(url.pathname.slice(1));

    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      this.handleList(res, url, key);
      return;
    }

    // Multipart upload (issue #367 §C8: `S3BlobStore.putStream`'s three
    // control calls). `uploads` (empty value) = initiate; `uploadId` alone
    // on a POST = complete; `uploadId` + `partNumber` on a PUT = one part;
    // `uploadId` alone on a DELETE = abort. Real S3 disambiguates the same
    // way — these query params never appear on a plain object PUT/DELETE.
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const uploadId = String(this.nextUploadId++);
      this.multipart.set(uploadId, { key, parts: new Map() });
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult>` +
          `<Bucket></Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId>` +
          `</InitiateMultipartUploadResult>`,
      );
      return;
    }

    if (
      req.method === 'PUT' &&
      url.searchParams.has('uploadId') &&
      url.searchParams.has('partNumber')
    ) {
      const uploadId = url.searchParams.get('uploadId') ?? '';
      const partNumber = Number(url.searchParams.get('partNumber'));
      const upload = this.multipart.get(uploadId);
      if (!upload) {
        res.writeHead(404, {});
        res.end();
        return;
      }
      const body = await readBody(req);
      upload.parts.set(partNumber, body);
      res.writeHead(200, { etag: `"part-${partNumber}"` });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      const uploadId = url.searchParams.get('uploadId') ?? '';
      const upload = this.multipart.get(uploadId);
      if (!upload) {
        res.writeHead(404, {});
        res.end();
        return;
      }
      await readBody(req); // the complete-request XML body — parts already came in via PUT
      const ordered = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, buf]) => buf);
      this.objects.set(upload.key, Buffer.concat(ordered));
      this.multipart.delete(uploadId);
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult>` +
          `<Bucket></Bucket><Key>${escapeXml(upload.key)}</Key></CompleteMultipartUploadResult>`,
      );
      return;
    }

    if (req.method === 'DELETE' && url.searchParams.has('uploadId')) {
      const uploadId = url.searchParams.get('uploadId') ?? '';
      this.multipart.delete(uploadId);
      res.writeHead(204, {});
      res.end();
      return;
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      this.objects.set(key, body);
      res.writeHead(200, {});
      res.end();
      return;
    }

    if (req.method === 'GET') {
      const obj = this.objects.get(key);
      if (!obj) {
        res.writeHead(404, {});
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': String(obj.length) });
      res.end(obj);
      return;
    }

    if (req.method === 'HEAD') {
      const obj = this.objects.get(key);
      if (!obj) {
        res.writeHead(404, {});
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': String(obj.length) });
      res.end();
      return;
    }

    if (req.method === 'DELETE') {
      this.objects.delete(key);
      res.writeHead(204, {});
      res.end();
      return;
    }

    res.writeHead(405, {});
    res.end();
  }

  private handleList(res: http.ServerResponse, url: URL, bucket: string): void {
    const prefix = url.searchParams.get('prefix') ?? '';
    const bucketPrefix = `${bucket}/`;
    const allMatching = [...this.objects.keys()]
      .filter((k) => k.startsWith(bucketPrefix) && k.slice(bucketPrefix.length).startsWith(prefix))
      .sort();
    const pageSize = this.listPageSize;
    const token = url.searchParams.get('continuation-token');
    const startIndex = token ? Number.parseInt(token, 10) : 0;
    const page = allMatching.slice(startIndex, startIndex + pageSize);
    const isTruncated = startIndex + pageSize < allMatching.length;
    const contents = page
      .map((k) => {
        const objKey = k.slice(bucketPrefix.length);
        const size = this.objects.get(k)?.length ?? 0;
        return `<Contents><Key>${escapeXml(objKey)}</Key><Size>${size}</Size></Contents>`;
      })
      .join('');
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}` +
      `<IsTruncated>${isTruncated}</IsTruncated>` +
      (isTruncated
        ? `<NextContinuationToken>${startIndex + pageSize}</NextContinuationToken>`
        : '') +
      `</ListBucketResult>`;
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(xml);
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
