/**
 * The module the sandbox substitutes for `node:fs/promises`. It is the
 * `promises` object of the confined mirror, re-exported in the named shape the
 * real builtin has, so `import { readFile } from "node:fs/promises"` inside an
 * untrusted graph binds to the confined implementation and not the real one.
 *
 * Same partial-mirror rule as `confined-fs.ts`: an entry point that is not
 * listed here is `undefined` in the untrusted graph, which fails loudly at the
 * call site instead of quietly resolving to unconfined authority.
 */

import { promises } from "./confined-fs.js";

export const readFile = promises.readFile;
export const stat = promises.stat;
export const lstat = promises.lstat;
export const readdir = promises.readdir;
export const realpath = promises.realpath;
export const access = promises.access;

export const writeFile = promises.writeFile;
export const appendFile = promises.appendFile;
export const mkdir = promises.mkdir;
export const rm = promises.rm;
export const unlink = promises.unlink;
export const rename = promises.rename;
export const copyFile = promises.copyFile;

export default promises;
