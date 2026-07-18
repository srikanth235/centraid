import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

/** Browser media probes commonly send `bytes=0-`; bound each response window. */
export const MAX_OPEN_RANGE_BYTES = 4 * 1024 * 1024;

/** `bytes=<start>-<end?>` -> a single satisfiable range, else null. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  // Suffix form `bytes=-N`: the final N bytes.
  const start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart);
  const end =
    rawStart === ''
      ? size - 1
      : rawEnd === ''
        ? Math.min(size - 1, start + MAX_OPEN_RANGE_BYTES - 1)
        : Number(rawEnd);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** Pipe a local blob while releasing the file descriptor on disconnect or error. */
export async function pipeBlobResponse(
  req: IncomingMessage,
  res: ServerResponse,
  source: Readable,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      source.off('error', onSourceError);
      req.off('aborted', onAbort);
      res.off('close', onAbort);
      res.off('finish', onFinish);
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
      // A peer disconnect is a completed transport outcome, not a route error
      // that can still be serialized onto the dead socket.
      settle();
    };
    const onSourceError = (error: Error): void => {
      if (!res.destroyed) res.destroy(error);
      settle(error);
    };
    source.once('error', onSourceError);
    req.once('aborted', onAbort);
    res.once('close', onAbort);
    res.once('finish', onFinish);
    source.pipe(res);
  });
}
