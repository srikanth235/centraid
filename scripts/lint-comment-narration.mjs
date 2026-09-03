#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
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
