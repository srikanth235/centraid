import { promises as fs } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { contentTypeFor, resolveStaticPath, staticSecurityHeaders } from './security.js';
import { sendError } from './http-utils.js';

export async function serveStatic(res: ServerResponse, appDir: string, rel: string): Promise<true> {
  const file = resolveStaticPath(appDir, rel);
  if (!file) return sendError(res, 404, 'not_found', 'Asset not found.');

  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch {
    return sendError(res, 404, 'not_found', 'Asset not found.');
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', contentTypeFor(file));
  for (const [k, v] of Object.entries(staticSecurityHeaders())) {
    res.setHeader(k, v);
  }
  res.end(buf);
  return true;
}
