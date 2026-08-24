#!/usr/bin/env node
// Historical-narration tripwire for code comments (issue #861) — WARN-ONLY.
//
// Comments face forward (docs/coding-standards.md): history is cited by bare
// issue link, never narrated. This tripwire greps comment lines for the
// past-tense markers that narration reaches for. It is fuzzy on purpose —
// "was" occurs in legitimate present-perfect prose — so every match is a
// review prompt, not a violation: a surviving match must pass the deletion
// test (state an obligation on future edits), not tell a story about a
// previous shape of the code. Tense is a surrogate — a changelog conjugated
// into present tense still fails the deletion test, and this lint can't see
// that.
//
// Warn-only permanently (#861 settled Q2): the signal is too noisy to gate on.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
// Git-tracked files only, so gitignored generated artifacts never pollute a
// run.
const TARGETS = ["packages", "apps"];
const files = execFileSync(
  "git",
  ["-C", ROOT, "ls-files", "-z", "--", ...TARGETS],
  {
    maxBuffer: 64 * 1024 * 1024,
  }
)
  .toString("utf8")
  .split("\0")
  .filter((f) => /\.(?:ts|tsx)$/u.test(f))
  .map((f) => path.join(ROOT, f));

const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/u;
const NARRATION =
  / (?:used to |until #\d|replaced |retired |previously |was a )/u;

let findings = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!COMMENT_LINE.test(line)) return;
    if (!NARRATION.test(line)) return;
    findings += 1;
    console.log(`${rel}:${i + 1} — ${line.trim().slice(0, 100)}`);
  });
}

console.log(
  findings === 0
    ? "lint-comment-narration: no past-tense markers in comments"
    : `lint-comment-narration: ${findings} line(s) to review — each survivor must state a present constraint (warn-only)`
);
process.exit(0);
