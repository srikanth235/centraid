#!/usr/bin/env node
// Dangling comment file-reference sweep (issue #861) — WARN-ONLY.
//
// Comments face forward (docs/coding-standards.md): a comment may name another
// source file only if that file exists. A "replaces `X.ts`" or "`X.ts` calls
// this" comment becomes a lie the day X is deleted or renamed, and nothing
// else in the toolchain notices — rename tooling and grep see symbols, not
// prose. This sweep extracts backticked `*.ts` / `*.tsx` basenames from
// comment lines and warns when the basename exists nowhere in the tree.
//
// Warn-only by design: it always exits 0. It is a sweep lane, not a gate —
// promotion to a blocking directive is a separate ruling recorded on #861.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
// Comments in packages/ and apps/ are swept; the living-basename set also
// covers root tests/, scripts/, and root-level configs, which app comments
// legitimately point at. Enumeration is git-tracked files only, so gitignored
// generated artifacts (wrangler type dumps, dist output) never pollute a run.
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

// Every basename that exists anywhere in the tree. Basename granularity keeps
// the check immune to directory moves, which are not the rot being hunted.
const living = new Set(tracked(LIVING_TARGETS).map((f) => path.basename(f)));

// A backticked *.ts/*.tsx name inside a // or /* */ comment line. Path
// prefixes are allowed inside the backticks; only the basename is checked.
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
      // A bare extension token (`.d.ts`, `.test.ts`) names a convention, not
      // a file.
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
