/**
 * The module the sandbox substitutes for `node:fs` inside an untrusted handler
 * graph — a READ-ONLY, ROOT-CONFINED mirror. Every path argument goes through
 * `guardReadPath` first, and every mutating entry point throws.
 *
 * Deliberately a PARTIAL mirror: an entry point that is not exported here is
 * `undefined` in the untrusted graph and fails at the call site rather than
 * silently resolving to unconfined authority. Fail-closed by omission — which
 * is also why a lane that grants filesystem access must be integration-tested
 * against its real dependency graph rather than assumed to work.
 *
 * The real `node:fs` is imported here and that import is not confined: this is
 * trusted sandbox code, and the hook in `install.ts` only confines graphs
 * rooted at the untrusted handler file.
 */

import * as realFs from "node:fs";

import * as confinedPromises from "./confined-fs-promises.js";
import { deniedWrite } from "./denied.js";
import { guardReadPath } from "./fs-guard.js";

/** Every write entry point resolves to the same refusal. */
function refuseWrite(operation: string): () => never {
  return () => {
    throw deniedWrite(operation);
  };
}

export function readFileSync(
  target: unknown,
  options?: unknown
): string | Buffer {
  return realFs.readFileSync(
    guardReadPath("readFileSync", target),
    options as Parameters<typeof realFs.readFileSync>[1]
  );
}

export function existsSync(target: unknown): boolean {
  // A refusal must not be softened into `false`: a handler probing outside its
  // roots is an escape attempt, and reporting "not there" would hide it.
  return realFs.existsSync(guardReadPath("existsSync", target));
}

export function statSync(
  target: unknown,
  options?: unknown
): ReturnType<typeof realFs.statSync> {
  return realFs.statSync(
    guardReadPath("statSync", target),
    options as Parameters<typeof realFs.statSync>[1]
  );
}

export function lstatSync(
  target: unknown,
  options?: unknown
): ReturnType<typeof realFs.lstatSync> {
  return realFs.lstatSync(
    guardReadPath("lstatSync", target),
    options as Parameters<typeof realFs.lstatSync>[1]
  );
}

export function readdirSync(
  target: unknown,
  options?: unknown
): ReturnType<typeof realFs.readdirSync> {
  return realFs.readdirSync(
    guardReadPath("readdirSync", target),
    options as Parameters<typeof realFs.readdirSync>[1]
  );
}

export function realpathSync(target: unknown): string {
  return realFs.realpathSync(guardReadPath("realpathSync", target));
}

export function openSync(
  target: unknown,
  flags?: unknown,
  mode?: unknown
): number {
  const normalized = typeof flags === "string" ? flags : "r";
  // Only read modes; `w`, `a`, `r+` and friends all reach the write path.
  if (!normalized.startsWith("r") || normalized.includes("+")) {
    throw deniedWrite("openSync");
  }
  return realFs.openSync(
    guardReadPath("openSync", target),
    normalized as Parameters<typeof realFs.openSync>[1],
    mode as Parameters<typeof realFs.openSync>[2]
  );
}

export function createReadStream(
  target: unknown,
  options?: unknown
): ReturnType<typeof realFs.createReadStream> {
  return realFs.createReadStream(
    guardReadPath("createReadStream", target),
    options as Parameters<typeof realFs.createReadStream>[1]
  );
}

export const constants = realFs.constants;

export const writeFileSync = refuseWrite("writeFileSync");
export const appendFileSync = refuseWrite("appendFileSync");
export const mkdirSync = refuseWrite("mkdirSync");
export const rmSync = refuseWrite("rmSync");
export const rmdirSync = refuseWrite("rmdirSync");
export const unlinkSync = refuseWrite("unlinkSync");
export const renameSync = refuseWrite("renameSync");
export const copyFileSync = refuseWrite("copyFileSync");
export const chmodSync = refuseWrite("chmodSync");
export const symlinkSync = refuseWrite("symlinkSync");
export const createWriteStream = refuseWrite("createWriteStream");
export const watch = refuseWrite("watch");

/** `fs.promises`, the same confined surface `node:fs/promises` resolves to. */
export const promises = confinedPromises;

export default {
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  promises,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
};
