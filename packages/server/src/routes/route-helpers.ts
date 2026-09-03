import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type * as TypeImport_g9tn66 from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { createBrotliCompress, createGzip, constants } from "node:zlib";

import { isHarnessKind, negotiateEncoding } from "@centraid/server/engine";
import type { HarnessKind } from "@centraid/server/engine";
import {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  PEER_ENDPOINT_HEADER,
  TUNNEL_FORWARDED_HEADER,
} from "@centraid/tunnel";

export const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;

export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  if (!address) return false;
  return (
    address === "::1" ||
    address === "127.0.0.1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

export function isDirectHostRequest(req: IncomingMessage): boolean {
  return (
    isLoopbackRequest(req) &&
    req.headers[DEVICE_IDENTITY_HEADER] === undefined &&
    req.headers[DEVICE_PROOF_HEADER] === undefined &&
    req.headers[PEER_ENDPOINT_HEADER] === undefined &&
    req.headers[TUNNEL_FORWARDED_HEADER] === undefined
  );
}

export interface FileMapEntry {
  path: string;
  content: string;
}

const EDITABLE_EXT = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".html",
  ".htm",
  ".css",
  ".json",
  ".md",
  ".txt",
  ".svg",
]);

const MAX_FILE_MAP_BYTES = 1 * 1024 * 1024; // 1 MiB per file

export async function writeFileMap(
  appDir: string,
  files: ReadonlyArray<FileMapEntry>
): Promise<void> {
  async function writeNext(index: number): Promise<void> {
    const f = files[index];
    if (!f) return;
    const abs = path.resolve(appDir, f.path);
    if (abs !== appDir && !abs.startsWith(appDir + path.sep)) {
      throw new Error(`refusing to write outside the app: ${f.path}`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.content, "utf8");
    return writeNext(index + 1);
  }
  await writeNext(0);
}

export async function readFileMap(appDir: string): Promise<FileMapEntry[]> {
  const out: FileMapEntry[] = [];
  await walkFileMap(appDir, "", out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function walkFileMap(
  root: string,
  rel: string,
  out: FileMapEntry[]
): Promise<void> {
  const here = rel ? path.join(root, rel) : root;
  let entries: TypeImport_g9tn66.Dirent[];
  try {
    entries = await fs.readdir(here, { withFileTypes: true });
  } catch {
    return;
  }
  async function readNext(index: number): Promise<void> {
    const e = entries[index];
    if (!e) return;
    if (e.name.startsWith(".")) return readNext(index + 1);
    const r = rel ? path.posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      await walkFileMap(root, r, out);
      return readNext(index + 1);
    }
    if (!e.isFile()) return readNext(index + 1);
    if (!EDITABLE_EXT.has(path.extname(e.name).toLowerCase()))
      return readNext(index + 1);
    const abs = path.join(root, r);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || stat.size > MAX_FILE_MAP_BYTES) return readNext(index + 1);
    out.push({
      path: r,
      content: await fs.readFile(abs, "utf8").catch(() => ""),
    });
    return readNext(index + 1);
  }
  await readNext(0);
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown
): true {
  return sendJsonBytes(res, status, Buffer.from(JSON.stringify(body)));
}

export function sendJsonText(
  res: ServerResponse,
  status: number,
  text: string
): true {
  return sendJsonBytes(res, status, Buffer.from(text));
}

function sendJsonBytes(
  res: ServerResponse,
  status: number,
  bytes: Buffer
): true {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const encoding =
    bytes.length >= 1024
      ? (negotiateEncoding(res.req?.headers["accept-encoding"]) ?? undefined)
      : undefined;
  if (!encoding) {
    res.end(bytes);
    return true;
  }
  res.setHeader("Content-Encoding", encoding);
  res.setHeader("Vary", "Accept-Encoding");
  const compressor =
    encoding === "br"
      ? createBrotliCompress({
          params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
        })
      : createGzip({ level: 6 });
  compressor.once("error", (error) => res.destroy(error));
  Readable.from(bytes).pipe(compressor).pipe(res);
  return true;
}

export function sendJsonConditional(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown
): true {
  const bytes = Buffer.from(JSON.stringify(body));
  const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
  res.setHeader("ETag", etag);
  const presented = req.headers["if-none-match"];
  const header = Array.isArray(presented) ? presented.join(",") : presented;
  if (header !== undefined && matchesEtag(header, etag)) {
    res.statusCode = 304;
    res.removeHeader("Content-Type");
    res.end();
    return true;
  }
  return sendJsonBytes(res, status, bytes);
}

function matchesEtag(header: string, etag: string): boolean {
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .some((token) => token.trim().replace(/^W\//u, "") === etag);
}

export function sendError(res: ServerResponse, err: unknown): true {
  return sendJson(res, 500, {
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

export async function readBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf =
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJson(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES
): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, maxBytes)).toString("utf8");
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

export function parseProviderConsent(
  value: unknown
): HarnessKind[] | undefined | "invalid" {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return undefined;
  if (!values.every((entry): entry is HarnessKind => isHarnessKind(entry)))
    return "invalid";
  return values;
}
