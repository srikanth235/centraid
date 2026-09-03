export type SandboxDeniedCode =
  | "CENTRAID_SANDBOX_DENIED"
  | "CENTRAID_SANDBOX_FS_DENIED"
  | "CENTRAID_SANDBOX_FS_WRITE_DENIED";

export class SandboxDeniedError extends Error {
  readonly code: SandboxDeniedCode;

  constructor(code: SandboxDeniedCode, message: string) {
    super(message);
    this.name = "SandboxDeniedError";
    this.code = code;
  }
}

export function denied(reason: string): SandboxDeniedError {
  return new SandboxDeniedError(
    "CENTRAID_SANDBOX_DENIED",
    `sandbox refused: ${reason}`
  );
}

export function deniedPath(
  operation: string,
  target: string,
  roots: readonly string[]
): SandboxDeniedError {
  return new SandboxDeniedError(
    "CENTRAID_SANDBOX_FS_DENIED",
    `sandbox refused fs.${operation} on ${target}: outside the granted read roots [${roots.join(", ")}]`
  );
}

export function deniedWrite(operation: string): SandboxDeniedError {
  return new SandboxDeniedError(
    "CENTRAID_SANDBOX_FS_WRITE_DENIED",
    `sandbox refused fs.${operation}: the confined filesystem mirror is read-only`
  );
}
