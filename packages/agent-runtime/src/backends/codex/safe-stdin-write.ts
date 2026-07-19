import type { Writable } from 'node:stream';

const IGNORED_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

/**
 * Write a line to a child process stdin without letting late EPIPE (or other
 * closed-pipe races) become uncaught exceptions that fail the Vitest process.
 *
 * Node can surface EPIPE asynchronously even when `writable` was true a moment
 * earlier — attach a one-shot error sink and use the write callback.
 */
export function safeStdinWrite(stdin: Writable | null | undefined, line: string): void {
  if (!stdin || !stdin.writable) return;
  ensureStdinErrorSink(stdin);
  try {
    stdin.write(line, (err) => {
      if (!err) return;
      const code = (err as NodeJS.ErrnoException).code;
      if (code && IGNORED_CODES.has(code)) return;
      // Other write errors are still ignored at the send boundary: the turn
      // path already fails via process exit / pending RPC rejection.
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code && IGNORED_CODES.has(code)) return;
  }
}

function ensureStdinErrorSink(stdin: Writable): void {
  const marker = '__centraidSafeStdinSink';
  if ((stdin as { [marker]?: boolean })[marker]) return;
  (stdin as { [marker]?: boolean })[marker] = true;
  stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code && IGNORED_CODES.has(err.code)) return;
    // Swallow: a dead child is reported via the process `exit` / `error` handlers.
  });
}

/** Test helper: is this error code one we intentionally ignore on stdin? */
export function isIgnorableStdinError(err: { code?: string } | null | undefined): boolean {
  return Boolean(err?.code && IGNORED_CODES.has(err.code));
}
