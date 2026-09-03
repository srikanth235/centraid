#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCAN_TARGETS = ["packages", "apps"];
const LIVING_TARGETS = ["packages", "apps", "tests", "scripts", "*.ts"];

function tracked(pathspecs) {
  return execFileSync(
    "git",
    ["-C", ROOT, "ls-files", "-z", "--", ...pathspecs],
    {
      maxBuffer: 64 * 1024 * 1024,
    }
  )
    .toString("utf8")
    .split("\0")
    .filter((f) => /\.(?:ts|tsx)$/u.test(f))
    .map((f) => path.join(ROOT, f));
}

const files = tracked(SCAN_TARGETS);

const living = new Set(tracked(LIVING_TARGETS).map((f) => path.basename(f)));

const REF = /`(?<ref>[\w./-]*?(?<base>[\w.-]+\.tsx?))`/gu;
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/u;

let findings = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!COMMENT_LINE.test(line)) return;
    for (const m of line.matchAll(REF)) {
      const basename = m.groups.base;
      if (m.groups.ref.startsWith(".")) continue;
      if (living.has(basename)) continue;
      findings += 1;
      console.log(
        `${rel}:${i + 1} — dangling ref \`${m.groups.ref}\` (no ${basename} in tree)`
      );
    }
  });
}

console.log(
  findings === 0
    ? "lint-comment-file-refs: clean — every comment file reference is live"
    : `lint-comment-file-refs: ${findings} dangling reference(s) — fix the comment, not the check (warn-only)`
);
process.exit(0);
