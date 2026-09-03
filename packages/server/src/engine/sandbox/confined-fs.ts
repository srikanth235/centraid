import * as realFs from "node:fs";

import * as confinedPromises from "./confined-fs-promises.js";
import { deniedWrite } from "./denied.js";
import { guardReadPath } from "./fs-guard.js";

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
