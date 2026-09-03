import type { IncomingMessage, ServerResponse } from "node:http";
import zlib from "node:zlib";

export const MIN_COMPRESS_BYTES = 1024;

export type Encoding = "br" | "gzip";

export function negotiateEncoding(
  header: string | string[] | undefined
): Encoding | null {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return null;
  const q = new Map<string, number>();
  for (const part of raw.split(",")) {
    const [nameRaw, ...params] = part.trim().split(";");
    const name = nameRaw?.trim().toLowerCase();
    if (!name) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q=(?<weight>[0-9.]+)\s*$/iu.exec(p);
      const parsed = m?.groups?.weight;
      if (parsed !== undefined) weight = Number(parsed);
    }
    q.set(name, Number.isNaN(weight) ? 0 : weight);
  }
  const br = q.get("br") ?? q.get("*");
  if (br !== undefined && br > 0) return "br";
  const gzip = q.get("gzip") ?? q.get("*");
  if (gzip !== undefined && gzip > 0) return "gzip";
  return null;
}

export interface CompressQuality {
  brotli: number;
  gzip: number;
}

export const DYNAMIC_QUALITY: CompressQuality = { brotli: 4, gzip: 6 };

export function compress(
  buf: Buffer,
  encoding: Encoding,
  quality: CompressQuality
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer): void => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };
    if (encoding === "br") {
      zlib.brotliCompress(
        buf,
        {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: quality.brotli,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
          },
        },
        done
      );
      return;
    }
    zlib.gzip(buf, { level: quality.gzip }, done);
  });
}

export async function sendJsonNegotiated(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown
): Promise<true> {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Vary", "Accept-Encoding");
  const encoding =
    raw.length >= MIN_COMPRESS_BYTES
      ? negotiateEncoding(req.headers["accept-encoding"])
      : null;
  if (!encoding) {
    res.end(raw);
    return true;
  }
  res.setHeader("Content-Encoding", encoding);
  res.end(await compress(raw, encoding, DYNAMIC_QUALITY));
  return true;
}
