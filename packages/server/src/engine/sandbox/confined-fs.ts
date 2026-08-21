/**
 * The module the sandbox substitutes for `node:fs` inside an untrusted handler
 * graph. It is a READ-ONLY, ROOT-CONFINED mirror: every path argument is
 * resolved (symlinks included) and refused unless it lands inside one of the
 * roots the lane granted, and every mutating entry point throws.
 *
 * It is deliberately a *partial* mirror. Only the read surface below is
 * exported, so a dependency reaching for an entry point that is not here gets
 * `undefined` and fails at the call site rather than silently receiving the
 * unconfined original. That is fail-closed by omission, and it is the reason a
 * lane that grants filesystem access must be integration-tested against its
 * real dependency graph rather than assumed to work.
 *
 * The real `node:fs` is imported here at module scope. That import is not
 * confined, and must not be: this module is trusted sandbox code, and the hook
 * in `install.ts` only confines graphs rooted at the untrusted handler file.
 */

import * as realFs from "node:fs";
import * as realFsPromises from "node:fs/promises";
import path from "node:path";

import { isPathWithinRoots, normalizeRoots } from "./policy.js";

let roots: readonly string[] = Object.freeze([]);

/**
 * Set by `installWorkerSandbox` before the untrusted graph loads. Called with
 * the lane's granted roots; calling it with an empty list leaves the mirror
 * refusing everything, which is the correct failure direction.
 */
export function setConfinedReadRoots(next: readonly string[]): void {
  roots = normalizeRoots(next);
}

/** Current roots — for assertions in tests and for the denial message. */
export function confinedReadRoots(): readonly string[] {
  return roots;
}

export class SandboxFilesystemDenied extends Error {
  readonly code = "CENTRAID_SANDBOX_FS_DENIED";
  constructor(operation: string, target: string) {
    super(
      `sandbox refused fs.${operation} on ${target}: outside the granted read roots [${roots.join(", ")}]`
    );
    this.name = "SandboxFilesystemDenied";
  }
}

export class SandboxWriteDenied extends Error {
  readonly code = "CENTRAID_SANDBOX_FS_WRITE_DENIED";
  constructor(operation: string) {
    super(
      `sandbox refused fs.${operation}: the confined filesystem mirror is read-only`
    );
    this.name = "SandboxWriteDenied";
  }
}

/**
 * Resolve a path argument to a real, absolute path and check it against the
 * roots. Symlinks are followed via `realpathSync` so a link *inside* a root
 * that points outside it is refused rather than followed. When the target does
 * not exist, its nearest existing ancestor is realpath-ed instead — otherwise a
 * probe for a non-existent file would skip the check entirely.
 */
function guard(operation: string, target: unknown): string {
  const raw =
    typeof target === "string"
      ? target
      : target instanceof URL
        ? target.pathname
        : Buffer.isBuffer(target)
          ? target.toString("utf8")
          : null;
  if (raw === null) throw new SandboxFilesystemDenied(operation, String(target));
  const absolute = path.resolve(raw);
  let probe = absolute;
  let suffix = "";
  for (;;) {
    try {
      const real = realFs.realpathSync(probe);
      const candidate = suffix === "" ? real : path.join(real, suffix);
      if (!isPathWithinRoots(candidate, roots)) {
        throw new SandboxFilesystemDenied(operation, absolute);
      }
      return absolute;
    } catch (error) {
      if (error instanceof SandboxFilesystemDenied) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) {
        // Walked to the filesystem root without finding an existing ancestor.
        throw new SandboxFilesystemDenied(operation, absolute);
      }
      suffix = suffix === "" ? path.basename(probe) : path.join(path.basename(probe), suffix);
      probe = parent;
    }
  }
}

function denyWrite(operation: string): () => never {
  return () => {
    throw new SandboxWriteDenied(operation);
  };
}

// ---- read surface (confined) ------------------------------------------------

export function readFileSync(
  target: unknown,
  options?: unknown
): string | Buffer {
  return realFs.readFileSync(
    guard("readFileSync", target),
    options as Parameters<typeof realFs.readFileSync>[1]
  );
}

export function existsSync(target: unknown): boolean {
  try {
    return realFs.existsSync(guard("existsSync", target));
  } catch (error) {
    if (error instanceof SandboxFilesystemDenied) throw error;
    return false;
  }
}

export function statSync(
  target: unknown,
  options?: unknown
): ReturnType<typeof realFs.statSync> {
  return realFs.statSync(
    guard("statSync", target),
    options as Parameters<typeof realFs.statSync>[1]
  );
}

export function lstatSync(
  target: unknown,
  options?: unknown
): ReturnType<typeof realFs.lstatSync> {
  return realFs.lstatSync(
    guard("lstatSync", target),
    options as Parameters<typeof realFs.lstatSync>[1]
  );
}

export function readdirSync(
  target: unknown,
  options?: unknown
): ReturnType<typeof realFs.readdirSync> {
  return realFs.readdirSync(
    guard("readdirSync", target),
    options as Parameters<typeof realFs.readdirSync>[1]
  );
}

export function realpathSync(target: unknown): string {
  return realFs.realpathSync(guard("realpathSync", target));
}

export function openSync(target: unknown, flags?: unknown, mode?: unknown): number {
  const normalized = typeof flags === "string" ? flags : "r";
  if (!/^r/u.test(normalized)) throw new SandboxWriteDenied("openSync");
  return realFs.openSync(
    guard("openSync", target),
    normalized as Parameters<typeof realFs.openSync>[1],
    mode as Parameters<typeof realFs.openSync>[2]
  );
}

export function createReadStream(
  target: unknown,
  options?: unknown
): ReturnType<typeof realFs.createReadStream> {
  return realFs.createReadStream(
    guard("createReadStream", target),
    options as Parameters<typeof realFs.createReadStream>[1]
  );
}

export const constants = realFs.constants;

// ---- write surface (refused) ------------------------------------------------

export const writeFileSync = denyWrite("writeFileSync");
export const appendFileSync = denyWrite("appendFileSync");
export const mkdirSync = denyWrite("mkdirSync");
export const rmSync = denyWrite("rmSync");
export const rmdirSync = denyWrite("rmdirSync");
export const unlinkSync = denyWrite("unlinkSync");
export const renameSync = denyWrite("renameSync");
export const copyFileSync = denyWrite("copyFileSync");
export const chmodSync = denyWrite("chmodSync");
export const symlinkSync = denyWrite("symlinkSync");
export const createWriteStream = denyWrite("createWriteStream");
export const watch = denyWrite("watch");

// ---- promises surface -------------------------------------------------------

export const promises = Object.freeze({
  readFile: async (target: unknown, options?: unknown) =>
    realFsPromises.readFile(
      guard("promises.readFile", target),
      options as Parameters<typeof realFsPromises.readFile>[1]
    ),
  stat: async (target: unknown) =>
    realFsPromises.stat(guard("promises.stat", target)),
  lstat: async (target: unknown) =>
    realFsPromises.lstat(guard("promises.lstat", target)),
  readdir: async (target: unknown, options?: unknown) =>
    realFsPromises.readdir(
      guard("promises.readdir", target),
      options as Parameters<typeof realFsPromises.readdir>[1]
    ),
  realpath: async (target: unknown) =>
    realFsPromises.realpath(guard("promises.realpath", target)),
  access: async (target: unknown, mode?: number) =>
    realFsPromises.access(guard("promises.access", target), mode),
  writeFile: denyWrite("promises.writeFile"),
  appendFile: denyWrite("promises.appendFile"),
  mkdir: denyWrite("promises.mkdir"),
  rm: denyWrite("promises.rm"),
  unlink: denyWrite("promises.unlink"),
  rename: denyWrite("promises.rename"),
  copyFile: denyWrite("promises.copyFile"),
});

export default {
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  openSync,
  promises,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
};
