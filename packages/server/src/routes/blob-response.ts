import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";

export const MAX_OPEN_RANGE_BYTES = 4 * 1024 * 1024;

export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null {
  const match = header?.match(/^bytes=(?<rawStart>\d*)-(?<rawEnd>\d*)$/u);
  if (!match) return null;
  const rawStart = match.groups?.rawStart;
  const rawEnd = match.groups?.rawEnd;
  if (rawStart === "" && rawEnd === "") return null;
  const start =
    rawStart === "" ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end =
    rawStart === ""
      ? size - 1
      : rawEnd === ""
        ? Math.min(size - 1, start + MAX_OPEN_RANGE_BYTES - 1)
        : Number(rawEnd);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size)
    return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function pipeBlobResponse(
  req: IncomingMessage,
  res: ServerResponse,
  source: Readable
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      source.off("error", onSourceError);
      req.off("aborted", onAbort);
      res.off("close", onAbort);
      res.off("finish", onFinish);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onFinish = (): void => settle();
    const onAbort = (): void => {
      source.unpipe(res);
      source.destroy();
      settle();
    };
    const onSourceError = (): void => {
      if (!res.destroyed) res.destroy();
      settle();
    };
    source.once("error", onSourceError);
    req.once("aborted", onAbort);
    res.once("close", onAbort);
    res.once("finish", onFinish);
    source.pipe(res);
  });
}
