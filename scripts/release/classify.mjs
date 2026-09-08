#!/usr/bin/env node
/**
 * D4 — patch vs minor classification from a CHANGELOG fragment.
 *
 * A release is a **patch** only if every non-empty bullet under the target
 * version sits under a *Fixed* heading. Anything under Added / Changed /
 * Removed / Deprecated / Security (non-fix) → **minor**.
 * Agents never propose **major** before 1.0 (see docs/decisions.md F1/D4).
 *
 * Usage:
 *   node scripts/release/classify.mjs [path/to/CHANGELOG.md] [--version 0.2.0]
 *          [--require-candidate [--sha <40hex>] [--allow-uncandidated <why>]]
 *
 * #915 Wave 1 — the issue asks that "`release:classify` refuses a SHA that is
 * not a candidate". Classification is a pure read of CHANGELOG.md and has no
 * SHA of its own, so the refusal is OPT-IN here (`--require-candidate`) and
 * MANDATORY in `scripts/release/prepare.mjs`, which is the step a human
 * actually runs. This flag exists so a caller that only classifies still has
 * one call that answers both questions.
 * Exit 0 always when parseable; prints JSON `{ "bump": "patch"|"minor", "rationale": "..." }`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { assertHeadIsCandidate } from "./candidate-guard.mjs";
import { changelogSectionBody } from "./changelog-section.mjs";

const args = process.argv.slice(2);
let changelogPath = "CHANGELOG.md";
let version = null;
let requireCandidate = false;
let sha = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--version") version = args[++i];
  else if (args[i] === "--sha") sha = args[++i];
  else if (args[i] === "--require-candidate") requireCandidate = true;
  else if (args[i] === "--allow-uncandidated") {
    // consumed by the guard; skip its optional reason argument
    if (args[i + 1] && !args[i + 1].startsWith("-")) i += 1;
  } else if (!args[i].startsWith("-")) changelogPath = args[i];
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

const text = readFileSync(path.resolve(changelogPath), "utf8");

/**
 * @param {string} [heading] Version string; defaults to the Unreleased section.
 * @returns {{ heading: string, body: string } | null} Parsed section or null.
 */
function sectionFor(heading = "Unreleased") {
  // ## [0.2.0] or ## Unreleased
  const body = changelogSectionBody(text, heading);
  if (body === null) return null;
  return { heading, body };
}

const section = sectionFor(version ?? undefined);
if (!section) {
  process.stdout.write(
    JSON.stringify({
      bump: "minor",
      rationale: `no changelog section for ${version ?? "Unreleased"}; defaulting to minor`,
    }) + "\n"
  );
  process.exit(0);
}

const body = section.body;
const headings = [...body.matchAll(/^###\s+(?<heading>\w+)\s*$/gmu)].map((m) =>
  (m.groups?.heading ?? "").toLowerCase()
);
const bullets = [...body.matchAll(/^[-*]\s+\S/gmu)];

if (bullets.length === 0) {
  process.stdout.write(
    JSON.stringify({
      bump: "patch",
      rationale:
        "no changelog bullets under section; treat as empty patch candidate",
    }) + "\n"
  );
  process.exit(0);
}

// Only *Fixed* present → patch. Any Added/Changed/Removed/Deprecated/Security
// → minor. Bullets with no subsection heading at all → minor, because an
// unclassified change cannot be proven to be fix-only.
const onlyFixed = headings.length > 0 && headings.every((h) => h === "fixed");
const finalBump = onlyFixed ? "patch" : "minor";

const rationale =
  finalBump === "patch"
    ? "every changelog subsection is Fixed → patch"
    : `non-Fixed subsections present (${[...new Set(headings)].join(", ") || "none"}) → minor`;

process.stdout.write(
  JSON.stringify({ bump: finalBump, rationale, onlyFixed }) + "\n"
);
