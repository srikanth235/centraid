#!/usr/bin/env node
// Comment-only proof for a diff (#861) — sweep evidence, not a gate.
//
// Usage: `node scripts/comment-only-diff.mjs [<git-ref>]` (default origin/main).
//
// A doctrine sweep touches hundreds of files and must change no behaviour. Eyes
// cannot certify that at that size, and a line diff cannot either — reflowing a
// comment moves code lines. So both sides are reparsed and reprinted with
// `removeComments: true`: if the emitted code is byte-identical, the change was
// comment-only. That printed comparison is the evidence a sweep PR cites, and
// the same proof tests/quality/classification-ratchet.json's re-pins rest on.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_REF = "origin/main";

const printer = ts.createPrinter({ removeComments: true });

/** The file's code with every comment removed, normalized through the printer. */
export function printWithoutComments(text, fileName) {
  return printer.printFile(
    ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      true,
      fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
  );
}

const git = (root, args) =>
  execFileSync("git", ["-C", root, ...args], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");

/**
 * Tracked `.ts`/`.tsx` files differing between `ref` and the working tree.
 * Untracked files are out of scope: a sweep edits files that already exist.
 */
function changedFiles(root, ref) {
  const raw = git(root, [
    "diff",
    "--name-status",
    "-z",
    ref,
    "--",
    "*.ts",
    "*.tsx",
  ]).split("\0");
  const changes = [];
  for (let i = 0; i < raw.length; i += 1) {
    const status = raw[i];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({ status: status[0], from: raw[i + 1], to: raw[i + 2] });
      i += 2;
      continue;
    }
    changes.push({ status: status[0], from: raw[i + 1], to: raw[i + 1] });
    i += 1;
  }
  return changes;
}

export function commentOnlyDiff({ root = ROOT, ref = DEFAULT_REF } = {}) {
  const results = [];
  for (const change of changedFiles(root, ref)) {
    const rel = change.to ?? change.from;
    // Added and deleted files carry code that has no counterpart to compare
    // against — a sweep that adds or removes a file is not comment-only.
    if (change.status === "A" || change.status === "D") {
      results.push({ file: rel, commentOnly: false, reason: "added/deleted" });
      continue;
    }
    const before = git(root, ["show", `${ref}:${change.from}`]);
    const after = existsSync(path.join(root, rel))
      ? readFileSync(path.join(root, rel), "utf8")
      : "";
    const commentOnly =
      printWithoutComments(before, change.from) ===
      printWithoutComments(after, rel);
    results.push({
      file: rel,
      commentOnly,
      reason: commentOnly ? "" : "printed code differs",
    });
  }
  return results;
}

function main() {
  const ref = process.argv[2] ?? DEFAULT_REF;
  const results = commentOnlyDiff({ root: ROOT, ref });
  for (const result of results) {
    console.log(
      `${result.commentOnly ? "comment-only  " : "CODE CHANGED  "}${result.file}` +
        (result.reason ? ` (${result.reason})` : "")
    );
  }
  const offenders = results.filter((result) => !result.commentOnly);
  if (offenders.length === 0) {
    console.log(
      `comment-only-diff: ${results.length} changed file(s) vs ${ref} — all comment-only`
    );
    return;
  }
  console.error(
    `\ncomment-only-diff: ${offenders.length} of ${results.length} file(s) changed code vs ${ref}:`
  );
  for (const offender of offenders) console.error(`  ${offender.file}`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
