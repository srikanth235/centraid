// Tiny HTTP helpers shared by the gateway-runtime route modules
// (apps-store-routes, automations-routes). runtime-core's http-utils
// isn't exported, and these are small + handler-shaped, so they live
// here rather than reaching across packages.

import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Default request-body cap (1 MiB) for JSON + draft-file bodies. */
export const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
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
