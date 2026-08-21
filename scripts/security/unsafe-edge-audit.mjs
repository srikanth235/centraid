#!/usr/bin/env node
/**
 * Unsafe-edge audit over the first-party Rust crates (issue #842 W7.2).
 *
 * Centraid's Rust side is the tunnel data plane, its N-API native binding, and
 * the browser iroh WASM module — the three places where the product parses
 * bytes that arrived from a peer. `unsafe` there is where memory-safety
 * guarantees stop being the compiler's problem, so this lane makes every such
 * site visible and countable.
 *
 * Two rules, both tighten-only:
 *   1. Every `unsafe` site must carry a `// SAFETY:` comment on the same line
 *      or within the five lines above it, stating why the invariant holds.
 *      No ledger entry waives this.
 *   2. The per-crate count must EQUAL its ledger entry. Above it fails (new
 *      unsafe needs a reviewed bump); below it fails too (the ledger must be
 *      lowered in the same change that removes the site, so the ratchet cannot
 *      silently slacken while looking green).
 *
 * Today every crate is at 0, so the lane is a tripwire on the first `unsafe`
 * anyone adds rather than a backlog. That is a real gate, not a vacuous one:
 * `unsafe-edge-audit.test.mjs` seeds an unsafe block and asserts it goes red.
 *
 * Usage:  node scripts/security/unsafe-edge-audit.mjs [--root <dir>]
 * Exit:   0 clean · 1 unjustified site, count drift, or unknown crate
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "../..");
const LEDGER = path.join(import.meta.dirname, "rust-unsafe-ledger.json");

/** Directories never worth walking: build output and vendored trees. */
const SKIP_DIRS = new Set(["target", "node_modules", ".git", "dist", "build"]);

/** How many lines above an `unsafe` site a `// SAFETY:` note may sit. */
const SAFETY_LOOKBACK = 5;

/**
 * Matches the four shapes `unsafe` takes in Rust: a block, a function, a trait
 * impl, and an `extern` block. Word-bounded so `unsafely_named_thing` and the
 * substring inside an identifier do not count.
 * @type {RegExp}
 */
const UNSAFE_RE = /(?<![A-Za-z0-9_])unsafe(?![A-Za-z0-9_])/u;

/**
 * Strip the trailing part of a line that sits inside a `//` comment, so the
 * word `unsafe` appearing in prose is not counted as a site.
 * @param {string} line Raw source line.
 * @returns {string} The code portion of the line.
 */
export function codePortion(line) {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * Does an `unsafe` at `index` carry a SAFETY justification?
 * @param {string[]} lines All lines of the file.
 * @param {number} index Zero-based line index of the site.
 * @returns {boolean} True when a `// SAFETY:` note is on or above the line.
 */
export function hasSafetyNote(lines, index) {
  const start = Math.max(0, index - SAFETY_LOOKBACK);
  for (let i = start; i <= index; i += 1) {
    if (/\/\/[/!]?\s*SAFETY:/u.test(lines[i] ?? "")) return true;
  }
  return false;
}

/**
 * Find every `unsafe` site in one Rust source.
 * @param {string} source File contents.
 * @param {string} file Path used in the reported finding.
 * @returns {{file: string, line: number, text: string, justified: boolean}[]} Sites.
 */
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

/**
 * Recursively collect `.rs` files under a directory.
 * @param {string} dir Directory to walk.
 * @param {string[]} acc Accumulator.
 * @returns {string[]} Absolute paths of Rust sources.
 */
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

/**
 * Locate every first-party crate (a directory holding a `Cargo.toml`).
 * @param {string} root Repository root.
 * @returns {string[]} Crate directories, repo-relative and POSIX-separated.
 */
export function discoverCrates(root) {
  const found = [];
  /** @param {string} dir Directory to walk. */
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
        // Not a crate root; keep descending.
      }
      walk(child);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Run the audit.
 * @param {{root?: string, ledger?: Record<string, number>}} [options] Overrides for tests.
 * @returns {{ok: boolean, findings: string[], counts: Record<string, number>}} Result.
 */
export function auditUnsafeEdges(options = {}) {
  const root = options.root ?? DEFAULT_ROOT;
  const ledger =
    options.ledger ??
    /** @type {{crates: Record<string, number>}} */ (
      JSON.parse(readFileSync(LEDGER, "utf8"))
    ).crates;

  const crates = discoverCrates(root);
  const findings = [];
  /** @type {Record<string, number>} */
  const counts = {};

  for (const crate of crates) {
    const files = collectRustFiles(path.join(root, crate));
    /** @type {{file: string, line: number, text: string, justified: boolean}[]} */
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
