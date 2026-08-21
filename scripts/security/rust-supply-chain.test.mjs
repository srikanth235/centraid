/**
 * Tests for the Rust supply-chain gate (issue #842 W7.2).
 *
 * `cargo-audit` and `cargo-deny` are not installed in every environment, so
 * the gate's availability handling is the part most likely to rot into a
 * silent pass. These tests drive it through injected probe/run seams and pin
 * all four outcomes — including the one that matters most: a tool that probes
 * as available but produces no result for a crate must FAIL, never skip.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  classifyProbe,
  decideExit,
  discoverLockedCrates,
  runRustSupplyChain,
  RUST_SUPPLY_CHAIN_TOOLS,
} from "./rust-supply-chain.mjs";

/**
 * Build a tree of locked crates.
 * @param {string[]} crates Repo-relative crate directories.
 * @returns {string} The tree root.
 */
function lockedCrates(crates) {
  const root = tempDirSync("rust-supply-chain-");
  for (const crate of crates) {
    mkdirSync(path.join(root, crate), { recursive: true });
    writeFileSync(path.join(root, crate, "Cargo.toml"), '[package]\nname="x"\n');
    writeFileSync(path.join(root, crate, "Cargo.lock"), "version = 4\n");
  }
  return root;
}

const AVAILABLE = { status: 0, stdout: "cargo-audit 0.21.0\n", stderr: "" };
const MISSING = { status: 101, stdout: "", stderr: "error: no such command: `audit`\n" };

describe("classifyProbe", () => {
  test("reads the 'no such command' text, not just the exit code", () => {
    // cargo has reported a missing subcommand with both zero and non-zero
    // status across releases, which is why the text decides.
    expect(classifyProbe(MISSING)).toBe("missing");
    expect(classifyProbe({ ...MISSING, status: 0 })).toBe("missing");
  });

  test("classifies a working binary, a spawn failure and a broken binary", () => {
    expect(classifyProbe(AVAILABLE)).toBe("available");
    expect(classifyProbe({ status: null, error: new Error("ENOENT") })).toBe(
      "missing"
    );
    expect(classifyProbe({ status: 2, stdout: "", stderr: "segfault" })).toBe(
      "broken"
    );
  });
});

describe("discoverLockedCrates", () => {
  test("finds every crate holding a Cargo.lock, sorted", () => {
    const root = lockedCrates(["b/two", "a/one"]);
    expect(discoverLockedCrates(root)).toStrictEqual(["a/one", "b/two"]);
  });

  test("returns nothing when no crate is locked", () => {
    expect(discoverLockedCrates(tempDirSync("empty-"))).toStrictEqual([]);
  });
});

describe("decideExit", () => {
  const crates = ["a/one", "b/two"];
  const both = RUST_SUPPLY_CHAIN_TOOLS.map((t) => t.id);

  /**
   * @param {string} outcome Outcome to record for every tool/crate pair.
   * @returns {{tool: string, crate: string, outcome: string}[]} Records.
   */
  const allRecords = (outcome) =>
    both.flatMap((tool) => crates.map((crate) => ({ tool, crate, outcome })));

  test("passes when every tool ran clean on every crate", () => {
    expect(decideExit(allRecords("clean"), { require: false, crates })).toStrictEqual(
      { code: 0, reasons: [] }
    );
  });

  test("fails on a finding", () => {
    const { code, reasons } = decideExit(allRecords("finding"), {
      require: false,
      crates,
    });
    expect(code).toBe(1);
    expect(reasons.join("\n")).toContain("reported findings");
  });

  test("a guarded skip exits 0 by default", () => {
    const records = both.map((tool) => ({
      tool,
      crate: null,
      outcome: "skipped",
    }));
    expect(decideExit(records, { require: false, crates }).code).toBe(0);
  });

  test("the same skip FAILS under --require, which is what CI passes", () => {
    const records = both.map((tool) => ({
      tool,
      crate: null,
      outcome: "skipped",
    }));
    const { code, reasons } = decideExit(records, { require: true, crates });
    expect(code).toBe(1);
    expect(reasons.join("\n")).toContain("cargo install cargo-audit --locked");
  });

  test("AVAILABLE BUT DID NOT RUN fails — the rule this gate exists for", () => {
    // The dangerous shape: the tool is installed, one crate silently produced
    // no record, and the run still looked green. It must not.
    const records = both.flatMap((tool) => [
      { tool, crate: "a/one", outcome: "clean" },
    ]);
    const { code, reasons } = decideExit(records, { require: false, crates });
    expect(code).toBe(1);
    expect(reasons.join("\n")).toContain("produced no result for b/two");
    expect(reasons.join("\n")).toContain("must never read as a pass");
  });

  test("a tool that fails to execute fails the gate", () => {
    const records = both.flatMap((tool) =>
      crates.map((crate) => ({ tool, crate, outcome: "broken" }))
    );
    const { code, reasons } = decideExit(records, { require: false, crates });
    expect(code).toBe(1);
    expect(reasons.join("\n")).toContain("failed to execute");
  });
});

describe("runRustSupplyChain", () => {
  test("runs each available tool once per locked crate", () => {
    const root = lockedCrates(["a/one", "b/two"]);
    /** @type {{args: string[], cwd: string}[]} */
    const invocations = [];
    const result = runRustSupplyChain({
      root,
      probe: () => AVAILABLE,
      run: (args, cwd) => {
        invocations.push({ args, cwd });
        return { status: 0 };
      },
    });
    expect(invocations).toHaveLength(4);
    expect(invocations.map((i) => i.args[0])).toStrictEqual([
      "audit",
      "audit",
      "deny",
      "deny",
    ]);
    expect(decideExit(result.records, { require: false, crates: result.crates }).code).toBe(0);
  });

  test("points cargo-deny at the single repo-root policy file", () => {
    const root = lockedCrates(["a/one"]);
    /** @type {string[][]} */
    const invocations = [];
    runRustSupplyChain({
      root,
      probe: () => AVAILABLE,
      run: (args) => {
        invocations.push(args);
        return { status: 0 };
      },
    });
    const denyArgs = invocations.find((args) => args[0] === "deny");
    expect(denyArgs).toContain(path.join(root, "deny.toml"));
  });

  test("a missing tool produces a loud skip naming the exact unblock command", () => {
    const root = lockedCrates(["a/one"]);
    const result = runRustSupplyChain({
      root,
      probe: () => MISSING,
      run: () => {
        throw new Error("must not run a missing tool");
      },
    });
    expect(result.records.every((r) => r.outcome === "skipped")).toBe(true);
    const text = result.lines.join("\n");
    expect(text).toContain("SKIPPED (blocked-external)");
    expect(text).toContain("cargo install cargo-audit --locked");
    expect(text).toContain("cargo install cargo-deny --locked");
    expect(text).toContain("This lane is NOT a pass");
  });

  test("says so loudly when there is no crate to scan at all", () => {
    const result = runRustSupplyChain({
      root: tempDirSync("no-crates-"),
      probe: () => MISSING,
      run: () => ({ status: 0 }),
    });
    expect(result.lines.join("\n")).toContain("nothing to scan");
  });
});
