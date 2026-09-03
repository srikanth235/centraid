import { createHash, createHmac } from "node:crypto";

import type { S3Credentials } from "./s3.js";

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function encodeQueryPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function amzDateOf(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
}

function scopeOf(dateStamp: string, region: string): string {
  return `${dateStamp}/${region}/s3/aws4_request`;
}

function signingKeyOf(
  creds: S3Credentials,
  dateStamp: string,
  region: string
): Buffer {
  return hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, dateStamp), region), "s3"),
    "aws4_request"
  );
}

function signatureOf(key: Buffer, stringToSign: string): string {
  return createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
}

export function sha256HexOf(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/gu,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join("/");
}

export interface SignS3RequestParams {
  method: string;
  base: URL;
  path: string;
  region: string;
  credentials: S3Credentials;
  body?: Buffer;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface SignedS3Request {
  url: URL;
  headers: Record<string, string>;
}

export function signS3Request(params: SignS3RequestParams): SignedS3Request {
  const { method, base, path, region, credentials: creds, body } = params;
  const now = new Date();
  const amzDate = amzDateOf(now);
  const dateStamp = amzDate.slice(0, 8);

  const canonicalPath = `/${encodeKeyPath(path)}`;
  const query = params.query ?? {};
  const canonicalQuery = Object.keys(query)
    .sort()
    .map(
      (k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? "")}`
    )
    .join("&");

  const payloadHash = sha256HexOf(body ?? Buffer.alloc(0));
  const headers: Record<string, string> = {
    host: base.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(creds.sessionToken
      ? { "x-amz-security-token": creds.sessionToken }
      : {}),
    ...Object.fromEntries(
      Object.entries(params.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    ),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((k) => `${k}:${headers[k]!.trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = scopeOf(dateStamp, region);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256HexOf(canonicalRequest),
  ].join("\n");
  const signature = signatureOf(
    signingKeyOf(creds, dateStamp, region),
    stringToSign
  );

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

export interface PresignS3RequestParams {
  method: "GET" | "PUT";
  base: URL;
  path: string;
  region: string;
  credentials: S3Credentials;
  expiresSeconds?: number;
  query?: Record<string, string>;
  now?: Date;
}

export function presignS3Request(params: PresignS3RequestParams): URL {
  const creds = params.credentials;
  const now = params.now ?? new Date();
  const expires = Math.max(
    1,
    Math.min(604_800, Math.floor(params.expiresSeconds ?? 900))
  );
  const amzDate = amzDateOf(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = scopeOf(dateStamp, params.region);
  const query: Record<string, string> = {
    ...params.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${creds.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
    ...(creds.sessionToken
      ? { "X-Amz-Security-Token": creds.sessionToken }
      : {}),
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map(
      (key) => `${encodeQueryPart(key)}=${encodeQueryPart(query[key] ?? "")}`
    )
    .join("&");
  const canonicalPath = `/${encodeKeyPath(params.path)}`;
  const canonicalRequest = [
    params.method,
    canonicalPath,
    canonicalQuery,
    `host:${params.base.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256HexOf(canonicalRequest),
  ].join("\n");
  const signature = signatureOf(
    signingKeyOf(creds, dateStamp, params.region),
    stringToSign
  );
  const url = new URL(params.base.origin);
  url.pathname = canonicalPath;
  url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return url;
}
