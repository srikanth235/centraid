#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "../..");
const SKIP_DIRS = new Set(["target", "node_modules", ".git", "dist", "build"]);

export const RUST_SUPPLY_CHAIN_TOOLS = Object.freeze([
  Object.freeze({
    id: "cargo-audit",
    subcommand: "audit",
    argsFor: () => [
      "audit",
      "--deny",
      "warnings",
      "--ignore",
      "RUSTSEC-2023-0089",
      "--ignore",
      "RUSTSEC-2024-0436",
    ],
    install: "cargo install cargo-audit --locked",
    covers: "RustSec advisories against the crate's Cargo.lock",
  }),
  Object.freeze({
    id: "cargo-deny",
    subcommand: "deny",
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

export function classifyProbe(probe) {
  if (probe.error) return "missing";
  const text = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  if (/no such command/iu.test(text)) return "missing";
  if (probe.status === 0) return "available";
  return "broken";
}

export function discoverLockedCrates(root) {
  const found = [];
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
        // Intentionally empty.
      }
      walk(child);
    }
  };
  walk(root);
  return found.sort();
}

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
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
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
