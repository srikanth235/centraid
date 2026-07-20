/*
 * Pure crash-record formatting + rotation-decision logic (issue #351).
 * Electron-free so it unit-tests as plain logic; `crash-log.ts` wires in
 * `app.getPath('userData')` + real filesystem writes.
 */

export type CrashKind =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'render-process-gone'
  | 'child-process-gone';

export interface CrashRecord {
  /** ISO timestamp. */
  at: string;
  kind: CrashKind;
  message: string;
  stack?: string;
}

/** Normalize whatever `process.on('uncaughtException' | 'unhandledRejection', ...)` hands us. */
export function toCrashRecord(
  kind: CrashKind,
  err: unknown,
  now: () => Date = () => new Date(),
): CrashRecord {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : undefined;
  return { at: now().toISOString(), kind, message, ...(stack ? { stack } : {}) };
}

/** One newline-delimited JSON line — the crash log is NDJSON, cheap to `tail`/parse. */
export function formatCrashLine(record: CrashRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** True once the log has grown past the cap and should rotate before the next append. */
export function shouldRotate(currentSizeBytes: number, maxBytes: number): boolean {
  return currentSizeBytes > maxBytes;
}
