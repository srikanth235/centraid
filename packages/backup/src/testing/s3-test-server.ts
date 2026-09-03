import { createHash } from "node:crypto";
import http from "node:http";

export interface S3TestServerRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

export interface S3TestServerOptions {
  port?: number;
  host?: string;
  listPageSize?: number;
}

interface StoredObject {
  body: Buffer;
  etagOrHash: string;
  storedAt: number;
  storageClass: string;
}

export class S3TestServer {
  readonly url: string;
  readonly port: number;
  readonly requests: S3TestServerRequest[] = [];

  private readonly objects = new Map<string, StoredObject>();
  private readonly server: http.Server;
  private readonly listPageSize: number;
  private readonly multipart = new Map<
    string,
    { key: string; parts: Map<number, Buffer> }
  >();
  private nextUploadId = 1;

  private constructor(server: http.Server, port: number, listPageSize: number) {
    this.server = server;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.listPageSize = listPageSize;
  }

  static async start(options: S3TestServerOptions = {}): Promise<S3TestServer> {
    const listPageSize = options.listPageSize ?? 1000;
    const host = options.host ?? "127.0.0.1";
    let getSelf = (): S3TestServer => {
      throw new Error("S3TestServer request arrived before initialization");
    };
    const server = http.createServer((req, res) => {
      getSelf()
        .handle(req, res)
        .catch((error: unknown) => {
          if (!res.headersSent)
            res.writeHead(500, { "content-type": "text/plain" });
          res.end(error instanceof Error ? error.message : String(error));
        });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, host, () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("S3TestServer: failed to bind a TCP port");
    }
    const self = new S3TestServer(server, address.port, listPageSize);
    getSelf = () => self;
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

  clearRequests(): void {
    this.requests.length = 0;
  }

  private static compositeKey(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  hasObjectDirect(bucket: string, key: string): boolean {
    return this.objects.has(S3TestServer.compositeKey(bucket, key));
  }

  getObjectDirect(bucket: string, key: string): Buffer | undefined {
    return this.objects.get(S3TestServer.compositeKey(bucket, key))?.body;
  }

  putObjectDirect(bucket: string, key: string, data: Buffer): void {
    this.putStoredObject(S3TestServer.compositeKey(bucket, key), data);
  }

  getObjectMetadataDirect(
    bucket: string,
    key: string
  ):
    | {
        size: number;
        etagOrHash: string;
        storedAt: number;
        storageClass: string;
      }
    | undefined {
    const object = this.objects.get(S3TestServer.compositeKey(bucket, key));
    if (!object) return undefined;
    return {
      size: object.body.length,
      etagOrHash: object.etagOrHash,
      storedAt: object.storedAt,
      storageClass: object.storageClass,
    };
  }

  deleteObjectDirect(bucket: string, key: string): boolean {
    return this.objects.delete(S3TestServer.compositeKey(bucket, key));
  }

  listDirect(bucket: string, prefix = ""): string[] {
    const bucketPrefix = `${bucket}/`;
    const fullPrefix = `${bucketPrefix}${prefix}`;
    return [...this.objects.keys()]
      .filter((k) => k.startsWith(fullPrefix))
      .map((k) => k.slice(bucketPrefix.length))
      .sort();
  }

  private putStoredObject(key: string, body: Buffer): void {
    this.objects.set(key, {
      body,
      etagOrHash: createHash("sha256").update(body).digest("hex"),
      storedAt: Math.floor(Date.now() / 1000),
      storageClass: "STANDARD",
    });
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    this.requests.push({
      method: req.method ?? "",
      path: url.pathname + url.search,
      headers: req.headers,
    });

    const key = decodeURIComponent(url.pathname.slice(1));

    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      this.handleList(res, url, key);
      return;
    }

    if (req.method === "POST" && url.searchParams.has("uploads")) {
      const uploadId = String(this.nextUploadId++);
      this.multipart.set(uploadId, { key, parts: new Map() });
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult>` +
          `<Bucket></Bucket><Key>${escapeXml(key)}</Key><UploadId>${uploadId}</UploadId>` +
          `</InitiateMultipartUploadResult>`
      );
      return;
    }

    if (
      req.method === "PUT" &&
      url.searchParams.has("uploadId") &&
      url.searchParams.has("partNumber")
    ) {
      const uploadId = url.searchParams.get("uploadId") ?? "";
      const partNumber = Number(url.searchParams.get("partNumber"));
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

    if (req.method === "POST" && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId") ?? "";
      const upload = this.multipart.get(uploadId);
      if (!upload) {
        res.writeHead(404, {});
        res.end();
        return;
      }
      await readBody(req); // complete-request XML — parts already arrived via PUT
      const ordered = [...upload.parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, buf]) => buf);
      this.putStoredObject(upload.key, Buffer.concat(ordered));
      this.multipart.delete(uploadId);
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult>` +
          `<Bucket></Bucket><Key>${escapeXml(upload.key)}</Key></CompleteMultipartUploadResult>`
      );
      return;
    }

    if (req.method === "DELETE" && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId") ?? "";
      this.multipart.delete(uploadId);
      res.writeHead(204, {});
      res.end();
      return;
    }

    if (req.method === "PUT") {
      const body = await readBody(req);
      this.putStoredObject(key, body);
      res.writeHead(200, {});
      res.end();
      return;
    }

    if (req.method === "GET") {
      const obj = this.objects.get(key)?.body;
      if (!obj) {
        res.writeHead(404, {});
        res.end();
        return;
      }
      res.writeHead(200, { "content-length": String(obj.length) });
      res.end(obj);
      return;
    }

    if (req.method === "HEAD") {
      const obj = this.objects.get(key)?.body;
      if (!obj) {
        res.writeHead(404, {});
        res.end();
        return;
      }
      res.writeHead(200, { "content-length": String(obj.length) });
      res.end();
      return;
    }

    if (req.method === "DELETE") {
      this.objects.delete(key);
      res.writeHead(204, {});
      res.end();
      return;
    }

    res.writeHead(405, {});
    res.end();
  }

  private handleList(res: http.ServerResponse, url: URL, bucket: string): void {
    const prefix = url.searchParams.get("prefix") ?? "";
    const bucketPrefix = `${bucket}/`;
    const allMatching = [...this.objects.keys()]
      .filter(
        (k) =>
          k.startsWith(bucketPrefix) &&
          k.slice(bucketPrefix.length).startsWith(prefix)
      )
      .sort();
    const pageSize = this.listPageSize;
    const token = url.searchParams.get("continuation-token");
    const startIndex = token ? Math.trunc(Number(token)) : 0;
    const page = allMatching.slice(startIndex, startIndex + pageSize);
    const isTruncated = startIndex + pageSize < allMatching.length;
    const contents = page
      .map((k) => {
        const objKey = k.slice(bucketPrefix.length);
        const object = this.objects.get(k);
        const size = object?.body.length ?? 0;
        const etag = object?.etagOrHash ?? "";
        const lastModified = new Date(
          (object?.storedAt ?? 0) * 1000
        ).toISOString();
        const storageClass = object?.storageClass ?? "STANDARD";
        return (
          `<Contents><Key>${escapeXml(objKey)}</Key><Size>${size}</Size>` +
          `<ETag>&quot;${etag}&quot;</ETag><LastModified>${lastModified}</LastModified>` +
          `<StorageClass>${storageClass}</StorageClass></Contents>`
        );
      })
      .join("");
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}` +
      `<IsTruncated>${isTruncated}</IsTruncated>` +
      (isTruncated
        ? `<NextContinuationToken>${startIndex + pageSize}</NextContinuationToken>`
        : "") +
      `</ListBucketResult>`;
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(xml);
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
