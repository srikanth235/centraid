#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "../..");
const LEDGER = path.join(import.meta.dirname, "rust-unsafe-ledger.json");

const SKIP_DIRS = new Set(["target", "node_modules", ".git", "dist", "build"]);

const SAFETY_LOOKBACK = 5;

const UNSAFE_RE = /(?<![A-Za-z0-9_])unsafe(?![A-Za-z0-9_])/u;

export function codePortion(line) {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

export function hasSafetyNote(lines, index) {
  const start = Math.max(0, index - SAFETY_LOOKBACK);
  for (let i = start; i <= index; i += 1) {
    if (/\/\/[/!]?\s*SAFETY:/u.test(lines[i] ?? "")) return true;
  }
  return false;
}

export function scanRustSource(source, file) {
  const lines = source.split("\n");
  const sites = [];
  for (const [index, line] of lines.entries()) {
    if (!UNSAFE_RE.test(codePortion(line))) continue;
    sites.push({
      file,
      line: index + 1,
      text: line.trim(),
      justified: hasSafetyNote(lines, index),
    });
  }
  return sites;
}

function collectRustFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectRustFiles(path.join(dir, entry.name), acc);
      continue;
    }
    if (entry.name.endsWith(".rs")) acc.push(path.join(dir, entry.name));
  }
  return acc;
}

export function discoverCrates(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      try {
        statSync(path.join(child, "Cargo.toml"));
        found.push(path.relative(root, child).split(path.sep).join("/"));
      } catch {
        // Intentionally empty.
      }
      walk(child);
    }
  };
  walk(root);
  return found.sort();
}

export function auditUnsafeEdges(options = {}) {
  const root = options.root ?? DEFAULT_ROOT;
  const ledger =
    options.ledger ?? JSON.parse(readFileSync(LEDGER, "utf8")).crates;

  const crates = discoverCrates(root);
  const findings = [];
  const counts = {};

  for (const crate of crates) {
    const files = collectRustFiles(path.join(root, crate));
    const sites = [];
    for (const file of files) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      sites.push(...scanRustSource(readFileSync(file, "utf8"), relative));
    }
    counts[crate] = sites.length;

    for (const site of sites) {
      if (site.justified) continue;
      findings.push(
        `${site.file}:${site.line} — \`unsafe\` with no \`// SAFETY:\` justification within ${SAFETY_LOOKBACK} lines: ${site.text}`
      );
    }

    const allowed = ledger[crate];
    if (allowed === undefined) {
      findings.push(
        `crate "${crate}" has no entry in scripts/security/rust-unsafe-ledger.json — add one (value ${sites.length}) so its unsafe surface is ratcheted`
      );
      continue;
    }
    if (sites.length > allowed) {
      findings.push(
        `crate "${crate}" has ${sites.length} unsafe site(s) but the ledger allows ${allowed}. New unsafe needs a reviewed ledger bump, not a silent one.`
      );
    } else if (sites.length < allowed) {
      findings.push(
        `crate "${crate}" has ${sites.length} unsafe site(s) but the ledger still allows ${allowed}. Lower the ledger in this change — a ratchet that is not tightened is not a ratchet.`
      );
    }
  }

  for (const crate of Object.keys(ledger)) {
    if (!crates.includes(crate)) {
      findings.push(
        `ledger names crate "${crate}", which no longer exists. Remove the stale entry.`
      );
    }
  }

  return { ok: findings.length === 0, findings, counts };
}

/* c8 ignore start -- CLI shell; the audit itself is covered by the test file */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const rootFlag = process.argv.indexOf("--root");
  const result = auditUnsafeEdges(
    rootFlag === -1 ? {} : { root: path.resolve(process.argv[rootFlag + 1]) }
  );
  console.log("rust unsafe-edge audit");
  for (const [crate, count] of Object.entries(result.counts)) {
    console.log(`  ${crate}: ${count} unsafe site(s)`);
  }
  if (!result.ok) {
    console.error("\nFAIL");
    for (const finding of result.findings) console.error(`  - ${finding}`);
    process.exit(1);
  }
  console.log("\nOK — every unsafe site is justified and within its ledger.");
}
/* c8 ignore stop */
