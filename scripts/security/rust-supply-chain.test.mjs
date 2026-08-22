/**
 * Tests for the Rust supply-chain gate (issue #842 W7.2).
 *
 * `cargo-audit` and `cargo-deny` are not installed everywhere, so the gate's
 * availability handling is the part most likely to rot into a silent pass.
 * These drive it through injected probe/run seams and pin every outcome —
 * including the one that matters most: a tool that probes as AVAILABLE but
 * produces no result for a crate must FAIL, never skip.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyProbe,
  decideExit,
  discoverLockedCrates,
  runRustSupplyChain,
  RUST_SUPPLY_CHAIN_TOOLS,
} from "./rust-supply-chain.mjs";

const FIXTURE_ROOT = path.join(tmpdir(), "centraid-rust-supply-chain-fixtures");

/**
 * Build a tree of locked crates under a fixed, deterministic path.
 * @param {string} name Fixture name.
 * @param {string[]} crates Relative crate directories.
 * @returns {string} The tree root.
 */
function lockedCrates(name, crates) {
  const root = path.join(FIXTURE_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const crate of crates) {
    mkdirSync(path.join(root, crate), { recursive: true });
    writeFileSync(
      path.join(root, crate, "Cargo.toml"),
      '[package]\nname="x"\n'
    );
    writeFileSync(path.join(root, crate, "Cargo.lock"), "version = 4\n");
  }
  return root;
}

const AVAILABLE = { status: 0, stdout: "cargo-audit 0.21.0\n", stderr: "" };
const MISSING = {
  status: 101,
  stdout: "",
  stderr: "error: no such command: `audit`\n",
};
const TOOL_IDS = RUST_SUPPLY_CHAIN_TOOLS.map((t) => t.id);

test.after(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

test("classifyProbe reads the 'no such command' text, not just the exit code", () => {
  // cargo has reported a missing subcommand with both zero and non-zero status
  // across releases, which is why the text decides.
  assert.equal(classifyProbe(MISSING), "missing");
  assert.equal(classifyProbe({ ...MISSING, status: 0 }), "missing");
});

test("classifyProbe separates a working binary, a spawn failure and a broken one", () => {
  assert.equal(classifyProbe(AVAILABLE), "available");
  assert.equal(
    classifyProbe({ status: null, error: new Error("ENOENT") }),
    "missing"
  );
  assert.equal(
    classifyProbe({ status: 2, stdout: "", stderr: "segfault" }),
    "broken"
  );
});

test("discoverLockedCrates finds every crate holding a Cargo.lock, sorted", () => {
  const root = lockedCrates("discover", ["b/two", "a/one"]);
  assert.deepEqual(discoverLockedCrates(root), ["a/one", "b/two"]);
});

test("discoverLockedCrates returns nothing when no crate is locked", () => {
  const root = lockedCrates("empty", []);
  assert.deepEqual(discoverLockedCrates(root), []);
});

const CRATES = ["a/one", "b/two"];

/**
 * @param {string} outcome Outcome recorded for every tool/crate pair.
 * @returns {{tool: string, crate: string, outcome: string}[]} Records.
 */
function allRecords(outcome) {
  return TOOL_IDS.flatMap((tool) =>
    CRATES.map((crate) => ({ tool, crate, outcome }))
  );
}

/** @returns {{tool: string, crate: null, outcome: string}[]} Skip records. */
function skipRecords() {
  return TOOL_IDS.map((tool) => ({ tool, crate: null, outcome: "skipped" }));
}

test("every tool clean on every crate passes", () => {
  assert.deepEqual(
    decideExit(allRecords("clean"), { require: false, crates: CRATES }),
    { code: 0, reasons: [] }
  );
});

test("a finding fails the gate", () => {
  const { code, reasons } = decideExit(allRecords("finding"), {
    require: false,
    crates: CRATES,
  });
  assert.equal(code, 1);
  assert.match(reasons.join("\n"), /reported findings/u);
});

test("a guarded skip exits 0 by default", () => {
  assert.equal(
    decideExit(skipRecords(), { require: false, crates: CRATES }).code,
    0
  );
});

test("the same skip FAILS under --require, which is what CI passes", () => {
  const { code, reasons } = decideExit(skipRecords(), {
    require: true,
    crates: CRATES,
  });
  assert.equal(code, 1);
  assert.match(reasons.join("\n"), /cargo install cargo-audit --locked/u);
});

test("AVAILABLE BUT DID NOT RUN fails — the rule this gate exists for", () => {
  // The dangerous shape: the tool is installed, one crate silently produced no
  // record, and the run still looked green. It must not.
  const records = TOOL_IDS.map((tool) => ({
    tool,
    crate: "a/one",
    outcome: "clean",
  }));
  const { code, reasons } = decideExit(records, {
    require: false,
    crates: CRATES,
  });
  assert.equal(code, 1);
  assert.match(reasons.join("\n"), /produced no result for b\/two/u);
  assert.match(reasons.join("\n"), /must never read as a pass/u);
});

test("a tool that fails to execute fails the gate", () => {
  const { code, reasons } = decideExit(allRecords("broken"), {
    require: false,
    crates: CRATES,
  });
  assert.equal(code, 1);
  assert.match(reasons.join("\n"), /failed to execute/u);
});

test("runRustSupplyChain runs each available tool once per locked crate", () => {
  const root = lockedCrates("run-all", ["a/one", "b/two"]);
  /** @type {string[][]} */
  const invocations = [];
  const result = runRustSupplyChain({
    root,
    probe: () => AVAILABLE,
    run: (args) => {
      invocations.push(args);
      return { status: 0 };
    },
  });
  assert.equal(invocations.length, 4);
  assert.deepEqual(
    invocations.map((args) => args[0]),
    ["audit", "audit", "deny", "deny"]
  );
  assert.equal(
    decideExit(result.records, { require: false, crates: result.crates }).code,
    0
  );
});

test("cargo-deny is pointed at the single repo-root policy file", () => {
  const root = lockedCrates("deny-config", ["a/one"]);
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
  assert.ok(denyArgs?.includes(path.join(root, "deny.toml")));
});

test("a missing tool produces a loud skip naming the exact unblock command", () => {
  const root = lockedCrates("missing-tool", ["a/one"]);
  const result = runRustSupplyChain({
    root,
    probe: () => MISSING,
    run: () => {
      throw new Error("must not run a missing tool");
    },
  });
  assert.ok(result.records.every((r) => r.outcome === "skipped"));
  const text = result.lines.join("\n");
  assert.match(text, /SKIPPED \(blocked-external\)/u);
  assert.match(text, /cargo install cargo-audit --locked/u);
  assert.match(text, /cargo install cargo-deny --locked/u);
  assert.match(text, /This lane is NOT a pass/u);
});

test("no crate to scan at all is reported loudly rather than silently passing", () => {
  const root = lockedCrates("no-crates", []);
  const result = runRustSupplyChain({
    root,
    probe: () => MISSING,
    run: () => ({ status: 0 }),
  });
  assert.match(result.lines.join("\n"), /nothing to scan/u);
});
