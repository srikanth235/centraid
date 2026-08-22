/**
 * The one error the sandbox raises. Every refusal — a builtin outside the
 * lane's allowlist, a read outside the granted roots, a write to a read-only
 * mirror — is the same event from a handler's point of view: the containment
 * said no. One class with a machine-readable `code` keeps that a single thing
 * a caller can catch, rather than three classes a caller catches two of.
 */

export type SandboxDeniedCode =
  /** A module, global, or capability the lane does not grant. */
  | "CENTRAID_SANDBOX_DENIED"
  /** A path outside the lane's granted read roots. */
  | "CENTRAID_SANDBOX_FS_DENIED"
  /** Any write: the confined filesystem mirror is read-only in every lane. */
  | "CENTRAID_SANDBOX_FS_WRITE_DENIED";

export class SandboxDeniedError extends Error {
  readonly code: SandboxDeniedCode;

  constructor(code: SandboxDeniedCode, message: string) {
    super(message);
    this.name = "SandboxDeniedError";
    this.code = code;
  }
}

/** A capability refusal: `sandbox refused: <reason>`. */
export function denied(reason: string): SandboxDeniedError {
  return new SandboxDeniedError(
    "CENTRAID_SANDBOX_DENIED",
    `sandbox refused: ${reason}`
  );
}

/** A path refusal, naming the operation, the target, and the granted roots. */
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

/** A write refusal. The mirror never writes, in any lane, to any root. */
export function deniedWrite(operation: string): SandboxDeniedError {
  return new SandboxDeniedError(
    "CENTRAID_SANDBOX_FS_WRITE_DENIED",
    `sandbox refused fs.${operation}: the confined filesystem mirror is read-only`
  );
}
