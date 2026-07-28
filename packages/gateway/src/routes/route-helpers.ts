// Tiny HTTP helpers shared by the gateway-runtime route modules
// (apps-store-routes, automations-routes). app-engine's http-utils
// isn't exported, and these are small + handler-shaped, so they live
// here rather than reaching across packages.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createBrotliCompress, createGzip, constants } from 'node:zlib';
import { negotiateEncoding } from '@centraid/app-engine';
import {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  TUNNEL_FORWARDED_HEADER,
} from '@centraid/tunnel';

/** Default request-body cap (1 MiB) for JSON + draft-file bodies. */
export const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Whether the peer socket itself is loopback (Host/X-Forwarded-For do not count). */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  if (!address) return false;
  return (
    address === '::1' ||
    address === '127.0.0.1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  );
}

/**
 * The host itself made this request — a kernel-observed loopback peer that
 * no forwarder produced (issue #568 items A/B).
 *
 * Loopback alone is NOT an identity: the daemon's iroh forwarder, the Rust
 * byte relay, and the desktop phone tunnel all deliver REMOTE peers to
 * 127.0.0.1. Each stamps its markings on the way through, so a host-only
 * capability asks for a loopback socket AND the absence of every marking.
 */
export function isDirectHostRequest(req: IncomingMessage): boolean {
  return (
    isLoopbackRequest(req) &&
    req.headers[DEVICE_IDENTITY_HEADER] === undefined &&
    req.headers[DEVICE_PROOF_HEADER] === undefined &&
    req.headers[TUNNEL_FORWARDED_HEADER] === undefined
  );
}

/** A `{path, content}` pair — the file-map shape the scaffolders emit. */
export interface FileMapEntry {
  path: string;
  content: string;
}

/** Text extensions a draft read/write accepts — mirrors agent-harness. */
const EDITABLE_EXT = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.html',
  '.htm',
  '.css',
  '.json',
  '.md',
  '.txt',
  '.svg',
]);

const MAX_FILE_MAP_BYTES = 1 * 1024 * 1024; // 1 MiB per file

/**
 * Write a `{path, content}[]` file map into an app dir (a session
 * worktree's `apps/<id>/`). Each path is resolved + confined under
 * `appDir`; parents are created. Used by the gateway lifecycle routes
 * (issue #141) to stage a scaffolded/cloned app into a session.
 */
export async function writeFileMap(
  appDir: string,
  files: ReadonlyArray<FileMapEntry>,
): Promise<void> {
  for (const f of files) {
    const abs = path.resolve(appDir, f.path);
    if (abs !== appDir && !abs.startsWith(appDir + path.sep)) {
      throw new Error(`refusing to write outside the app: ${f.path}`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.content, 'utf8');
  }
}

/**
 * Read an app dir into a sorted `{path, content}[]` file map (text
 * files only, dotfiles skipped). The inverse of `writeFileMap`; the
 * lifecycle routes feed it to agent-harness's file-map editors
 * (`updateAppMetaFiles`, `setAutomationEnabledInFiles`, …).
 */
export async function readFileMap(appDir: string): Promise<FileMapEntry[]> {
  const out: FileMapEntry[] = [];
  await walkFileMap(appDir, '', out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function walkFileMap(root: string, rel: string, out: FileMapEntry[]): Promise<void> {
  const here = rel ? path.join(root, rel) : root;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(here, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? path.posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      await walkFileMap(root, r, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (!EDITABLE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const abs = path.join(root, r);
    const fd = await fs.open(abs, 'r').catch(() => null);
    if (!fd) continue;
    try {
      const stat = await fd.stat();
      if (stat.size > MAX_FILE_MAP_BYTES) continue;
      out.push({ path: r, content: await fd.readFile({ encoding: 'utf8' }) });
    } catch {
      // Unreadable files are skipped (previously they were pushed with empty content).
    } finally {
      await fd.close();
    }
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): true {
  const bytes = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const encoding =
    bytes.length >= 1024
      ? (negotiateEncoding(res.req?.headers['accept-encoding']) ?? undefined)
      : undefined;
  if (!encoding) {
    res.end(bytes);
    return true;
  }
  res.setHeader('Content-Encoding', encoding);
  res.setHeader('Vary', 'Accept-Encoding');
  const compressor =
    encoding === 'br'
      ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
      : createGzip({ level: 6 });
  compressor.once('error', (error) => res.destroy(error));
  Readable.from(bytes).pipe(compressor).pipe(res);
  return true;
}

/** Generic 500 for an unexpected error (route-specific senders wrap this). */
export function sendError(res: ServerResponse, err: unknown): true {
  return sendJson(res, 500, {
    error: 'internal_error',
    message: err instanceof Error ? err.message : String(err),
  });
}

export async function readBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJson(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, maxBytes)).toString('utf8');
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
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
