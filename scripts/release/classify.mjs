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

import { readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let changelogPath = 'CHANGELOG.md';
let version = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--version') version = args[++i];
  else if (!args[i].startsWith('-')) changelogPath = args[i];
}

const text = readFileSync(path.resolve(changelogPath), 'utf8');

/** @returns {{ heading: string, body: string } | null} Parsed changelog section or null. */
function sectionFor(ver) {
  // ## [0.2.0] or ## Unreleased
  const re = ver
    ? new RegExp(
        `^##\\s+\\[?${ver.replace(/\./g, '\\.')}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|$)`,
        'm',
      )
    : /^##\s+\[?Unreleased\]?[^\n]*\n([\s\S]*?)(?=^##\s+|$)/m;
  const m = text.match(re);
  if (!m) return null;
  return { heading: ver ?? 'Unreleased', body: m[1] ?? '' };
}

const section = sectionFor(version);
if (!section) {
  process.stdout.write(
    JSON.stringify({
      bump: 'minor',
      rationale: `no changelog section for ${version ?? 'Unreleased'}; defaulting to minor`,
    }) + '\n',
  );
  process.exit(0);
}

const body = section.body;
const headings = [...body.matchAll(/^###\s+(\w+)\s*$/gm)].map((m) => m[1].toLowerCase());
const bullets = [...body.matchAll(/^[-*]\s+\S/gm)];

if (bullets.length === 0) {
  process.stdout.write(
    JSON.stringify({
      bump: 'patch',
      rationale: 'no changelog bullets under section; treat as empty patch candidate',
    }) + '\n',
  );
  process.exit(0);
}

const nonFixed = headings.filter((h) => h !== 'fixed');
const bump = nonFixed.length === 0 && headings.includes('fixed') ? 'patch' : 'minor';
// Only *Fixed* present → patch. Empty headings with bullets under Fixed-only
// also patch. Any Added/Changed/Removed → minor. No Fixed but other headings → minor.
const onlyFixed =
  headings.length > 0 && headings.every((h) => h === 'fixed')
    ? true
    : headings.length === 0 && bump === 'patch';

const finalBump =
  headings.length === 0 ? 'minor' : headings.every((h) => h === 'fixed') ? 'patch' : 'minor';

const rationale =
  finalBump === 'patch'
    ? 'every changelog subsection is Fixed → patch'
    : `non-Fixed subsections present (${[...new Set(headings)].join(', ') || 'none'}) → minor`;

process.stdout.write(JSON.stringify({ bump: finalBump, rationale, onlyFixed }) + '\n');
