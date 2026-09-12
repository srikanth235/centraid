#!/usr/bin/env node
// Comment-only proof for a diff (#861) — sweep evidence, not a gate.
//
// Usage: `node scripts/comment-only-diff.ts [<git-ref>]` (default origin/main).
//
// A doctrine sweep touches hundreds of files and must change no behaviour. Eyes
// cannot certify that at that size, and a line diff cannot either — reflowing a
// comment moves code lines. Two comparisons run, each sound against a real code
// change, and EITHER passing proves the diff comment-only:
//   - leaf-token streams (comments/whitespace are trivia; JSDoc subtrees are
//     skipped; JsxText compares under JSX whitespace semantics) — blind only to
//     dropped syntax sugar like a union type's leading `|`;
//   - reprint with `removeComments: true` — blind only to preserved-formatting
//     noise like a block collapsing once its comment is deleted.
// This proof is the evidence a sweep PR cites, and the same proof
// tests/quality/classification-ratchet.json's re-pins rest on.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_REF = "origin/main";

const printer = ts.createPrinter({ removeComments: true });

/** The file's code with every comment removed, normalized through the printer. */
export function printWithoutComments(text: string, fileName: string) {
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

/** JSX text renders with newline-adjacent whitespace dropped and inner runs
 *  collapsed, so the comparison normalizes it the same way. */
function normalizeJsxText(text: string) {
  return text
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line !== "")
    .join(" ")
    .replace(/\s+/gu, " ");
}

/** The file's code as its leaf-token stream — trivia (comments, whitespace)
 *  never appears, so two equal streams differ only in trivia. */
export function codeTokens(text: string, fileName: string) {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    // JSDoc is a comment, but the parser gives it AST nodes — skip the subtree
    // or every JSDoc edit would read as a code change.
    if (ts.isJSDoc(node)) return;
    if (node.getChildCount(sf) === 0) {
      const text0 = node.getText(sf);
      tokens.push(
        node.kind === ts.SyntaxKind.JsxText ? normalizeJsxText(text0) : text0
      );
      return;
    }
    node.getChildren(sf).forEach(visit);
  };
  visit(sf);
  // A trailing comma before a closing bracket is formatter-owned syntax with
  // no semantics; drop it so a collapse-to-one-line reflow compares equal. The
  // separator is an escaped NUL, which no token text can contain.
  const closers = new Set(["]", "}", ")"]);
  const kept = tokens.filter(
    (token, index) => !(token === "," && closers.has(tokens[index + 1] ?? ""))
  );
  return kept.join("\u0000");
}

const git = (root: string, args: readonly string[]): string =>
  execFileSync("git", ["-C", root, ...args], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");

/**
 * Tracked `.ts`/`.tsx` files differing between `ref` and the working tree.
 * Untracked files are out of scope: a sweep edits files that already exist.
 */
function changedFiles(root: string, ref: string) {
  const raw = git(root, [
    "diff",
    "--name-status",
    "-z",
    ref,
    "--",
    "*.ts",
    "*.tsx",
  ]).split("\0");
  const changes: Array<{ status: string; from: string; to: string }> = [];
  for (let i = 0; i < raw.length; i += 1) {
    const status = raw[i];
    if (!status) continue;
    const kind = status[0] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = raw[i + 1];
      const to = raw[i + 2];
      if (from !== undefined && to !== undefined)
        changes.push({ status: kind, from, to });
      i += 2;
      continue;
    }
    const pathName = raw[i + 1];
    if (pathName !== undefined)
      changes.push({ status: kind, from: pathName, to: pathName });
    i += 1;
  }
  return changes;
}

export function commentOnlyDiff(
  options: { root?: string; ref?: string } = {}
): Array<{ file: string; commentOnly: boolean; reason: string }> {
  const { root = ROOT, ref = DEFAULT_REF } = options;
  const results: Array<{ file: string; commentOnly: boolean; reason: string }> =
    [];
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
      codeTokens(before, change.from) === codeTokens(after, rel) ||
      printWithoutComments(before, change.from) ===
        printWithoutComments(after, rel);
    results.push({
      file: rel,
      commentOnly,
      reason: commentOnly ? "" : "code tokens differ",
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
