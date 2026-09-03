/*
 * Pure crash-record formatting + rotation-decision logic (#351).
 * Electron-free so it unit-tests as plain logic; `crash-log.ts` wires in
 * `app.getPath('userData')` + real filesystem writes.
 */
export type CrashKind =
  | "uncaughtException"
  | "unhandledRejection"
  | "render-process-gone"
  | "child-process-gone";

export interface CrashRecord {
  at: string;
  kind: CrashKind;
  message: string;
  stack?: string;
}

export function toCrashRecord(
  kind: CrashKind,
  err: unknown,
  now: () => Date = () => new Date()
): CrashRecord {
  const message = err instanceof Error ? err.message : String(err);
  const stack =
    err instanceof Error && typeof err.stack === "string"
      ? err.stack
      : undefined;
  return {
    at: now().toISOString(),
    kind,
    message,
    ...(stack ? { stack } : {}),
  };
}

export function formatCrashLine(record: CrashRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function shouldRotate(
  currentSizeBytes: number,
  maxBytes: number
): boolean {
  return currentSizeBytes > maxBytes;
}
