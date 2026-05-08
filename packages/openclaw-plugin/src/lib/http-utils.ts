import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error("request body exceeds 1 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on("error", () => reject(new Error("request stream error")));
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): true {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(text);
  return true;
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): true {
  return sendJson(res, status, { error: code, message });
}

export function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * The cron webhook ingest endpoint must only accept connections from loopback.
 * The gateway's auth gate gives us authenticated callers, but ingest is a
 * different threat model — we want to be sure no remote client can ever hit
 * it, even if a misconfiguration exposes the gateway publicly.
 */
export function isLoopback(req: IncomingMessage): boolean {
  const xff = getHeader(req, "x-forwarded-for");
  if (xff) return false; // proxied — not a direct loopback caller
  const host = getHeader(req, "host") ?? "";
  return host.startsWith("127.0.0.1") || host.startsWith("[::1]") || host.startsWith("localhost");
}
