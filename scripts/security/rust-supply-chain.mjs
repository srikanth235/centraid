#!/usr/bin/env node
/**
 * Rust supply-chain gate (issue #842 W7.2): `cargo audit` for known
 * advisories and `cargo deny` for licences, duplicate versions, and banned or
 * unknown-registry sources, run over every first-party crate lockfile.
 *
 * The TypeScript side already has OSV over `bun.lock` (scripts/ci/
 * osv-lockfile-scan.mjs) and dependency-review on the PR diff. The Rust side
 * had neither, while shipping the code that terminates a QUIC connection from
 * an unauthenticated peer. This closes that asymmetry.
 *
 * ============================== AVAILABILITY ==============================
 *
 * `cargo-audit` and `cargo-deny` are separate cargo subcommand binaries. This
 * script has exactly three outcomes and no fourth:
 *
 *   RAN + CLEAN   → exit 0.
 *   RAN + FINDING → exit 1.
 *   NOT INSTALLED → a loud SKIPPED block naming the exact install command,
 *                   exit 0 by default, exit 1 under `--require`.
 *
 * There is deliberately no "installed but quietly not run" outcome: once a
 * tool probes as available, every crate must produce a run record, and a
 * missing record fails the gate. A guarded skip that could be mistaken for a
 * pass is worse than no lane at all.
 *
 * CI passes `--require`, because the workflow installs both tools — so in CI
 * a missing binary is an infrastructure failure and must be red, not skipped.
 *
 * Usage:  node scripts/security/rust-supply-chain.mjs [--require] [--root <dir>]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "../..");
const SKIP_DIRS = new Set(["target", "node_modules", ".git", "dist", "build"]);

/**
 * The two subcommands, with the exact command that unblocks each. Pinned
 * `--locked` installs so a CI runner cannot drift its own advisory tooling.
 */
export const RUST_SUPPLY_CHAIN_TOOLS = Object.freeze([
  Object.freeze({
    id: "cargo-audit",
    subcommand: "audit",
    argsFor: () => ["audit", "--deny", "warnings"],
    install: "cargo install cargo-audit --locked",
    covers: "RustSec advisories against the crate's Cargo.lock",
  }),
  Object.freeze({
    id: "cargo-deny",
    subcommand: "deny",
    // One shared policy at the repo root rather than three drifting copies;
    // cargo-deny only auto-discovers a `deny.toml` beside the crate.
    argsFor: (/** @type {string} */ root) => [
      "deny",
      "--all-features",
      "--config",
      path.join(root, "deny.toml"),
      "check",
    ],
    install: "cargo install cargo-deny --locked",
    covers: "licences, banned crates, duplicate versions, unknown registries",
  }),
]);

/**
 * Classify a `cargo <sub> --version` probe. cargo reports a missing
 * subcommand on stderr with a zero-ish exit in some versions and non-zero in
 * others, so the text is what decides, not the code alone.
 * @param {{status: number|null, stdout?: string, stderr?: string, error?: unknown}} probe Spawn result.
 * @returns {"available"|"missing"|"broken"} Classification.
 */
export function classifyProbe(probe) {
  if (probe.error) return "missing";
  const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  if (/no such command/iu.test(text)) return "missing";
  if (probe.status === 0) return "available";
  return "broken";
}

/**
 * Locate crates that own a `Cargo.lock` — the unit both tools consume.
 * @param {string} root Repository root.
 * @returns {string[]} Repo-relative crate directories.
 */
export function discoverLockedCrates(root) {
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
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      try {
        statSync(path.join(child, "Cargo.lock"));
        found.push(path.relative(root, child).split(path.sep).join("/"));
      } catch {
        // Not a locked crate root; keep descending.
      }
      walk(child);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Decide the process exit code from the collected records. Split out from the
 * IO so the "available but did not run" rule is testable without cargo.
 * @param {{tool: string, crate: string|null, outcome: string}[]} records Run records.
 * @param {{require: boolean, crates: string[]}} context Gate configuration.
 * @returns {{code: number, reasons: string[]}} Exit decision.
 */
export function decideExit(records, context) {
  const reasons = [];
  for (const tool of RUST_SUPPLY_CHAIN_TOOLS) {
    const mine = records.filter((r) => r.tool === tool.id);
    const skipped = mine.find((r) => r.outcome === "skipped");
    if (skipped) {
      if (context.require) {
        reasons.push(
          `${tool.id} is not installed but --require was passed: ${tool.install}`
        );
      }
      continue;
    }
    if (mine.some((r) => r.outcome === "broken")) {
      reasons.push(`${tool.id} failed to execute; the gate cannot pass on it`);
      continue;
    }
    // The load-bearing rule: an available tool owes one record per crate.
    const ran = new Set(
      mine.filter((r) => r.outcome !== "skipped").map((r) => r.crate)
    );
    for (const crate of context.crates) {
      if (!ran.has(crate)) {
        reasons.push(
          `${tool.id} is available but produced no result for ${crate} — an unrun lane must never read as a pass`
        );
      }
    }
    for (const record of mine) {
      if (record.outcome === "finding") {
        reasons.push(`${tool.id} reported findings in ${record.crate}`);
      }
    }
  }
  return { code: reasons.length === 0 ? 0 : 1, reasons };
}

/**
 * Execute the gate.
 * @param {{root?: string, require?: boolean, run?: Function, probe?: Function}} [options] Injection seams for tests.
 * @returns {{records: {tool: string, crate: string|null, outcome: string}[], crates: string[], lines: string[]}} Result.
 */
export function runRustSupplyChain(options = {}) {
  const root = options.root ?? DEFAULT_ROOT;
  const probe =
    options.probe ??
    ((sub) =>
      spawnSync("cargo", [sub, "--version"], {
        encoding: "utf8",
        cwd: root,
      }));
  const run =
    options.run ??
    ((args, cwd) =>
      spawnSync("cargo", args, { encoding: "utf8", cwd, stdio: "inherit" }));

  const crates = discoverLockedCrates(root);
  /** @type {{tool: string, crate: string|null, outcome: string}[]} */
  const records = [];
  const lines = [];

  if (crates.length === 0) {
    lines.push(
      "no crate with a Cargo.lock was found — the Rust lane has nothing to scan, which is itself suspicious"
    );
  }

  for (const tool of RUST_SUPPLY_CHAIN_TOOLS) {
    const availability = classifyProbe(probe(tool.subcommand));
    if (availability !== "available") {
      records.push({ tool: tool.id, crate: null, outcome: "skipped" });
      lines.push(
        "",
        `  SKIPPED (blocked-external): ${tool.id} is not installed on this machine.`,
        `    covers      : ${tool.covers}`,
        `    unblock with: ${tool.install}`,
        `    then re-run : node scripts/security/rust-supply-chain.mjs`,
        `    This lane is NOT a pass. It ran zero checks. CI passes --require,`,
        `    where a missing binary is a red build rather than a skip.`
      );
      continue;
    }
    for (const crate of crates) {
      const result = run(tool.argsFor(root), path.join(root, crate));
      const outcome = result.error
        ? "broken"
        : result.status === 0
          ? "clean"
          : "finding";
      records.push({ tool: tool.id, crate, outcome });
      lines.push(`  ${tool.id} ${crate}: ${outcome}`);
    }
  }

  return { records, crates, lines };
}

/* c8 ignore start -- CLI shell; the decision logic above is unit-covered */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requireTools = process.argv.includes("--require");
  const rootFlag = process.argv.indexOf("--root");
  const root =
    rootFlag === -1 ? DEFAULT_ROOT : path.resolve(process.argv[rootFlag + 1]);
  if (!existsSync(root)) {
    console.error(`root does not exist: ${root}`);
    process.exit(1);
  }
  console.log("rust supply-chain gate (cargo-audit + cargo-deny)");
  const { records, crates, lines } = runRustSupplyChain({
    root,
    require: requireTools,
  });
  for (const line of lines) console.log(line);
  const { code, reasons } = decideExit(records, {
    require: requireTools,
    crates,
  });
  if (code !== 0) {
    console.error("\nFAIL");
    for (const reason of reasons) console.error(`  - ${reason}`);
  }
  process.exit(code);
}
/* c8 ignore stop */
