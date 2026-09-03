import * as realFsPromises from "node:fs/promises";

import { deniedWrite } from "./denied.js";
import { guardReadPath } from "./fs-guard.js";

function refuseWrite(operation: string): () => never {
  return () => {
    throw deniedWrite(`promises.${operation}`);
  };
}

export async function readFile(
  target: unknown,
  options?: unknown
): Promise<string | Buffer> {
  return realFsPromises.readFile(
    guardReadPath("promises.readFile", target),
    options as Parameters<typeof realFsPromises.readFile>[1]
  );
}

export async function stat(
  target: unknown
): Promise<
  ReturnType<typeof realFsPromises.stat> extends Promise<infer T> ? T : never
> {
  return realFsPromises.stat(guardReadPath("promises.stat", target));
}

export async function lstat(
  target: unknown
): Promise<
  ReturnType<typeof realFsPromises.lstat> extends Promise<infer T> ? T : never
> {
  return realFsPromises.lstat(guardReadPath("promises.lstat", target));
}

export async function readdir(
  target: unknown,
  options?: unknown
): Promise<unknown> {
  return realFsPromises.readdir(
    guardReadPath("promises.readdir", target),
    options as Parameters<typeof realFsPromises.readdir>[1]
  );
}

export async function realpath(target: unknown): Promise<string> {
  return realFsPromises.realpath(guardReadPath("promises.realpath", target));
}

export async function access(target: unknown, mode?: number): Promise<void> {
  return realFsPromises.access(guardReadPath("promises.access", target), mode);
}

export const writeFile = refuseWrite("writeFile");
export const appendFile = refuseWrite("appendFile");
export const mkdir = refuseWrite("mkdir");
export const rm = refuseWrite("rm");
export const rmdir = refuseWrite("rmdir");
export const unlink = refuseWrite("unlink");
export const rename = refuseWrite("rename");
export const copyFile = refuseWrite("copyFile");
export const chmod = refuseWrite("chmod");
export const symlink = refuseWrite("symlink");
export const open = refuseWrite("open");

export default {
  access,
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
};
