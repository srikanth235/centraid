#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_REF = "origin/main";

const printer = ts.createPrinter({ removeComments: true });

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

function normalizeJsxText(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ")
    .replace(/\s+/gu, " ");
}

export function codeTokens(text, fileName) {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const tokens = [];
  const visit = (node) => {
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
  const closers = new Set(["]", "}", ")"]);
  const kept = tokens.filter(
    (token, index) => !(token === "," && closers.has(tokens[index + 1] ?? ""))
  );
  return kept.join("\u0000");
}

const git = (root, args) =>
  execFileSync("git", ["-C", root, ...args], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");

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
