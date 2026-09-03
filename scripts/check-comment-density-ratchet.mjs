#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import {
  INVENTORY_PATH,
  readLedgerSection,
  writeLedgerSection,
} from "./check-ledgers.mjs";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const BASELINE_REL = `${INVENTORY_PATH}#commentDensity`;
export const BASELINE_SECTION = "commentDensity";

export const CAP_PERCENT = 15;
export const CAP_MIN_LINES = 40;
export const GLOBAL_TARGET_PERCENT = 10;

export const TARGETS = [
  "packages/**/*.ts",
  "packages/**/*.tsx",
  "apps/**/*.ts",
  "apps/**/*.tsx",
];

const SEED_COMMENT =
  "The comment-density ratchet (#861). Doctrine governs what a comment may say; this budget governs how much. The metric is CHARACTER SHARE — non-whitespace characters inside TypeScript-parser comment ranges over non-whitespace characters of the whole file — measured by scripts/check-comment-density-ratchet.mjs over every git-tracked packages/** and apps/** .ts/.tsx file except .d.ts. Characters, not lines: a line count is gamed by fusing three comment lines into one wrapped sentence, and holding whitespace out of both sides keeps blank lines and reflowing out of the number. Every measured file carries a pin [commentChars, totalChars] and enforcement is DOWN-ONLY: any rise in a pinned file's share fails the gate, compared by integer cross-multiplication so a re-pin is exact and no regression rounds into the noise. Downward re-pins are free — `node scripts/check-comment-density-ratchet.mjs --write` recomputes every pin, adds new files, prunes deleted ones, and refuses to raise a pin, so --write cannot launder a regression. A deliberate raise is a hand edit to this file carrying an approved-deviation note in the issue receipt. A file with no pin and at least 40 non-blank lines fails above a 15% share; the global target is <=10% and the gate prints the running figure on every run, pass or fail. `allowlist` exempts a named file from the 15% cap ONLY, never from its pin, for registries where the prose IS the payload — it is the pressure valve that exists so nobody deletes load-bearing rationale to hit a number.";

const SEED_DEVIATION =
  "Seeded 2026-08-25 on the #861 Wave 0 tree: 3,638 files, global character share 24.31%, global line density 14.83%, 1,975 files above the 15% cap. Every pin here is expected to fall — the sweep waves under #861 are what lower them, and --write re-pins them as they do.";

const SEED_EXPIRY = "2026-12-01";

const SEED_ALLOWLIST = {
  "packages/design/src/blocks/contracts.ts":
    "prose contracts registry — the prose IS the payload (#861)",
};

export function trackedFiles(root = ROOT) {
  return execFileSync("git", ["-C", root, "ls-files", "-z", "--", ...TARGETS], {
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((file) => file !== "" && !file.endsWith(".d.ts"))
    .sort();
}

export function commentRanges(text, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const byPos = new Map();
  const visit = (node) => {
    if (node.getChildCount(sourceFile) === 0) {
      for (const range of ts.getLeadingCommentRanges(
        text,
        node.getFullStart()
      ) ?? []) {
        byPos.set(range.pos, range);
      }
      return;
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return {
    sourceFile,
    ranges: [...byPos.values()].sort((a, b) => a.pos - b.pos),
  };
}

const nonWhitespace = (text) => text.replace(/\s/gu, "").length;

export function measureFile(text, fileName) {
  const { sourceFile, ranges } = commentRanges(text, fileName);
  const lines = text.split("\n");
  const touched = new Set();
  let commentChars = 0;
  for (const range of ranges) {
    commentChars += nonWhitespace(text.slice(range.pos, range.end));
    const first = sourceFile.getLineAndCharacterOfPosition(range.pos).line;
    const last = sourceFile.getLineAndCharacterOfPosition(range.end).line;
    for (let line = first; line <= last; line += 1) touched.add(line);
  }
  let nonBlankLines = 0;
  for (const line of lines) if (line.trim() !== "") nonBlankLines += 1;
  let commentLines = 0;
  for (const line of touched) {
    if ((lines[line] ?? "").trim() !== "") commentLines += 1;
  }
  return {
    commentChars,
    totalChars: nonWhitespace(text),
    commentLines,
    nonBlankLines,
  };
}

export const capEligible = (measurement) =>
  measurement.nonBlankLines >= CAP_MIN_LINES;

export const overCap = (measurement) =>
  measurement.commentChars * 100 > CAP_PERCENT * measurement.totalChars;

export function measureTree({ root = ROOT, files } = {}) {
  const scanned = files ?? trackedFiles(root);
  const measured = new Map();
  const totals = {
    files: 0,
    commentChars: 0,
    totalChars: 0,
    commentLines: 0,
    nonBlankLines: 0,
    overCap: 0,
  };
  for (const rel of scanned) {
    const measurement = measureFile(
      readFileSync(path.join(root, rel), "utf8"),
      rel
    );
    measured.set(rel, measurement);
    totals.files += 1;
    totals.commentChars += measurement.commentChars;
    totals.totalChars += measurement.totalChars;
    totals.commentLines += measurement.commentLines;
    totals.nonBlankLines += measurement.nonBlankLines;
    if (capEligible(measurement) && overCap(measurement)) totals.overCap += 1;
  }
  return { measured, totals };
}

export const rose = (pin, measurement) =>
  measurement.commentChars * pin[1] > pin[0] * measurement.totalChars;

const percent = (commentChars, totalChars) =>
  `${totalChars === 0 ? "0.00" : ((commentChars / totalChars) * 100).toFixed(2)}%`;

const RISE_REMEDY =
  "cut the comment back, or record an approved deviation in the receipt and hand-raise the pin";
const CAP_REMEDY =
  "cut the comment back, or record an approved deviation in the receipt and allowlist the file with a reason if its prose is the payload";

export function verifyRatchet(baseline, measured) {
  const pins = baseline.files ?? {};
  const allowlist = baseline.allowlist ?? {};
  const failures = [];
  for (const [rel, pin] of Object.entries(pins)) {
    const measurement = measured.get(rel);
    if (!measurement || !rose(pin, measurement)) continue;
    failures.push(
      `${rel} — comment share rose ${percent(pin[0], pin[1])} -> ` +
        `${percent(measurement.commentChars, measurement.totalChars)}; ${RISE_REMEDY}`
    );
  }
  for (const [rel, measurement] of measured) {
    if (pins[rel] || allowlist[rel]) continue;
    if (!capEligible(measurement) || !overCap(measurement)) continue;
    failures.push(
      `${rel} — unpinned file at ` +
        `${percent(measurement.commentChars, measurement.totalChars)} exceeds the ` +
        `${CAP_PERCENT}% cap over ${measurement.nonBlankLines} non-blank lines; ${CAP_REMEDY}`
    );
  }
  return failures;
}

export function reconcileRatchet(baseline, measured) {
  const pins = baseline.files ?? {};
  const files = {};
  const refused = [];
  for (const rel of [...measured.keys()].sort()) {
    const measurement = measured.get(rel);
    const pin = pins[rel];
    if (pin && rose(pin, measurement)) {
      files[rel] = pin;
      refused.push(
        `${rel} — pinned at ${percent(pin[0], pin[1])}, measured ` +
          `${percent(measurement.commentChars, measurement.totalChars)}`
      );
      continue;
    }
    files[rel] = [measurement.commentChars, measurement.totalChars];
  }
  return {
    next: {
      _comment: baseline._comment ?? SEED_COMMENT,
      _entries: baseline._entries ?? "population",
      issue: baseline.issue ?? 915,
      expires: baseline.expires ?? SEED_EXPIRY,
      approvedDeviation: baseline.approvedDeviation ?? SEED_DEVIATION,
      allowlist: baseline.allowlist ?? {},
      files,
    },
    refused,
  };
}

export function loadBaseline(root = ROOT) {
  const section = readLedgerSection(INVENTORY_PATH, BASELINE_SECTION, root);
  if (section) return section;
  return {
    _comment: SEED_COMMENT,
    _entries: "population",
    issue: 915,
    expires: SEED_EXPIRY,
    approvedDeviation: SEED_DEVIATION,
    allowlist: Object.fromEntries(
      Object.entries(SEED_ALLOWLIST).filter(([rel]) =>
        trackedFiles(root).includes(rel)
      )
    ),
    files: {},
  };
}

function reportTotals(totals) {
  console.log(
    `comment-density: ${totals.files} file(s) — character share ` +
      `${percent(totals.commentChars, totals.totalChars)} (target <=${GLOBAL_TARGET_PERCENT}%), ` +
      `line density ${percent(totals.commentLines, totals.nonBlankLines)}, ` +
      `${totals.overCap} file(s) over the ${CAP_PERCENT}% cap`
  );
}

function main() {
  const baseline = loadBaseline(ROOT);
  const { measured, totals } = measureTree({ root: ROOT });

  if (process.argv.includes("--write")) {
    const { next, refused } = reconcileRatchet(baseline, measured);
    writeLedgerSection(INVENTORY_PATH, BASELINE_SECTION, next, ROOT);
    reportTotals(totals);
    for (const line of refused) console.warn(`warn  refused to raise ${line}`);
    console.log(
      `comment-density: wrote ${Object.keys(next.files).length} pin(s) to ${BASELINE_REL}` +
        (refused.length > 0
          ? ` — ${refused.length} risen pin(s) left at their old value; the gate still fails on them`
          : "")
    );
    return;
  }

  const failures = verifyRatchet(baseline, measured);
  reportTotals(totals);
  if (failures.length === 0) {
    console.log(
      "ok   comment-density — no pin rose, no unpinned file over cap"
    );
    return;
  }
  console.error(`\nFAIL — ${failures.length} comment-density violation(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
