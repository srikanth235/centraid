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
 * Exit 0 always when parseable; prints JSON `{ "bump": "patch"|"minor", "rationale": "..." }`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { changelogSectionBody } from "./changelog-section.mjs";

const args = process.argv.slice(2);
let changelogPath = "CHANGELOG.md";
let version = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--version") version = args[++i];
  else if (!args[i].startsWith("-")) changelogPath = args[i];
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
