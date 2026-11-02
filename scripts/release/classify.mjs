#!/usr/bin/env node
/**
 * D4 — patch vs minor classification from the commits since the last `v*` tag.
 *
 * Any `feat` commit → **minor**, otherwise **patch**. A `!` or
 * `BREAKING CHANGE` is reported but never picks **major**: agents never
 * propose major before 1.0. No releasable commits → not a candidate.
 *
 * Usage:
 *   node scripts/release/classify.mjs
 *          [--require-candidate [--sha <40hex>] [--allow-uncandidated <why>]]
 *
 * #915 Wave 1 — the issue asks that "`release:classify` refuses a SHA that is
 * not a candidate". Classification has no SHA of its own, so the refusal is
 * OPT-IN here (`--require-candidate`) and MANDATORY in
 * `scripts/release/prepare.mjs`, which is the step a human actually runs.
 * Exit 0 always when parseable; prints JSON
 * `{ "bump": "patch"|"minor"|null, "candidate": boolean, "rationale": "..." }`.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

import { assertHeadIsCandidate } from "./candidate-guard.mjs";
import { classifyBump, commitsSinceLastTag } from "./release-commits.mjs";

const args = process.argv.slice(2);
let requireCandidate = false;
let sha = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--sha") sha = args[++i];
  else if (args[i] === "--require-candidate") requireCandidate = true;
  else if (args[i] === "--allow-uncandidated") {
    // consumed by the guard; skip its optional reason argument
    if (args[i + 1] && !args[i + 1].startsWith("-")) i += 1;
  }
}

if (requireCandidate) {
  assertHeadIsCandidate({
    argv: args,
    // `--sha` names the commit to judge; without it the guard reads HEAD, which
    // is the same thing in the normal case and clearer than defaulting silently.
    ...(sha
      ? {
          run: (file, argv) =>
            file === "git" && argv[0] === "rev-parse"
              ? `${sha}\n`
              : execFileSync(file, argv, { encoding: "utf8" }),
        }
      : {}),
  });
}

const result = classifyBump(
  commitsSinceLastTag(path.resolve(import.meta.dirname, "../.."))
);
process.stdout.write(JSON.stringify(result) + "\n");
