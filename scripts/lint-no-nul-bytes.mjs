#!/usr/bin/env node
// No tracked text file carries a raw NUL byte (#931 item 2).
//
// WHY THIS IS NOT COSMETIC. Git decides "binary" by sniffing the first 8 KiB
// for a NUL. One `\x00` inside a template literal — the composite-key delimiter
// idiom `${a}\x00${b}` typed literally instead of escaped — flips the whole
// file to binary, and from that moment `git diff` prints "Binary files differ"
// and `--numstat` prints `-\t-`. Every later hunk in that file is invisible to
// textual review. It happened three times: #916's audit, #928 w1b, and
// `packages/vault/src/grant/authority-registry.ts`, which had been sitting on
// `main` making a kilobyte of grant-authority edits unreviewable.
//
// The fix is always the same and always free: write `\0`, which is the same
// byte to the program and an ordinary two-character sequence to git.
//
// WHAT IS SCANNED. Every tracked file whose extension is not in BINARY_EXTS
// below. The list is stated rather than sniffed because sniffing is how the
// bug got in: "does it contain a NUL" is precisely the question, so it cannot
// also be the way the file is classified.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Extensions whose files are binary by construction, so a NUL says nothing.
 *
 * Images and app icons, the vendored web fonts, the Android keystore and
 * gradle wrapper jar, the wasm-bindgen bundle, the fuzz corpus seeds (`.bin`,
 * which exist to hold arbitrary bytes) and the gzipped golden vaults under
 * `packages/vault/tests/golden/` (`.gz`). Every one of them is already opaque
 * to textual review and nothing about that is a defect.
 */
export const BINARY_EXTS = Object.freeze([
  ".bin",
  ".gz",
  ".icns",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".keystore",
  ".node",
  ".png",
  ".ttf",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
]);

/**
 * The one tracked text file allowed to hold a NUL, and why.
 *
 * `receipts/*.md` are frozen at the default-branch baseline by the
 * `doc-integrity` directive: the bytes on `main` may not be rewritten, only
 * appended to. This receipt's NUL sits inside prose describing this exact
 * idiom, so the gate cannot ask for a fix that governance forbids. A NUL in a
 * receipt that has not merged yet is still caught — the entry names one path,
 * not the folder.
 */
export const ALLOWED = Object.freeze([
  "receipts/issue-573-toolchain-opinions-one-shot.md",
]);

/**
 * Should this path be read as text?
 * @param {string} file A repo-relative path.
 * @returns {boolean} True when a NUL in it is a defect.
 */
export function isScanned(file) {
  if (ALLOWED.includes(file)) return false;
  return !BINARY_EXTS.includes(path.extname(file).toLowerCase());
}

/**
 * Where the NUL bytes are, as line/column pairs.
 * @param {Buffer} buffer The file's bytes.
 * @returns {{line: number, column: number}[]} One entry per NUL, 1-based.
 */
export function nulPositions(buffer) {
  const hits = [];
  let line = 1;
  let column = 1;
  for (const byte of buffer) {
    if (byte === 0) hits.push({ line, column });
    if (byte === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return hits;
}

/**
 * Scan a list of paths.
 * @param {string[]} files Repo-relative paths.
 * @param {(file: string) => Buffer} read Reads one file's bytes.
 * @returns {string[]} One human-readable failure per offending file.
 */
export function scan(files, read) {
  const failures = [];
  for (const file of files) {
    if (!isScanned(file)) continue;
    const hits = nulPositions(read(file));
    if (hits.length === 0) continue;
    const where = hits
      .slice(0, 5)
      .map((hit) => `${hit.line}:${hit.column}`)
      .join(", ");
    failures.push(
      `${file}: ${hits.length} raw NUL byte(s) at ${where}${hits.length > 5 ? ", …" : ""} — ` +
        `git classifies the file as binary, so every diff in it becomes unreviewable. Write \\0 instead.`
    );
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const present = tracked.filter((file) => {
    // A path in the index that is not a regular file on disk (a submodule, or
    // a checkout the sparse rules skipped) is not this gate's business.
    try {
      return statSync(path.join(ROOT, file)).isFile();
    } catch {
      return false;
    }
  });
  const failures = scan(present, (file) => readFileSync(path.join(ROOT, file)));
  for (const failure of failures) console.error(`no-nul-bytes: ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log(
    `no-nul-bytes: ${present.filter(isScanned).length} tracked text files, none carrying a raw NUL`
  );
}
