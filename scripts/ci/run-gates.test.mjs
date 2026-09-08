// The runner itself, end to end (#988).
//
// `gate-stamp.test.mjs` exercises the predicate directly, so it stayed green
// over a `run-gates.mjs` that referenced `tierIsComplete` without importing it:
// every green run executed all its gates and then died with a ReferenceError on
// the stamping path, exiting 1. A unit test of a predicate cannot see that
// class of defect; only spawning the runner and reading its EXIT CODE can.
//
// The gates are stubs in a throwaway git repo — `run-gates.mjs` spawns
// `bun run <name>` in its own cwd, and the stamp key needs a git tree, so a
// temp repo with a package.json of one-word scripts is the whole harness. No
// real gate runs here.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
// oxlint-disable-next-line no-restricted-imports -- (#988) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; every directory below is removed in its own finally. Same pattern as scripts/check-ledgers.test.mjs.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { STATIC_TIER } from "./gate-stamp.mjs";

const RUNNER = path.resolve(import.meta.dirname, "run-gates.mjs");

// The stamp store lives OUTSIDE the stub repo on purpose: a stamp written
// inside the working tree would move the very oid it is keyed on, and the
// second run would never match. That is also why the real default is the
// user's cache home.

/** A git repo whose package.json defines every static gate as a stub. */
function stubRepo(failing = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "run-gates-"));
  const scripts = Object.fromEntries(
    STATIC_TIER.map((name) => [
      name,
      failing.includes(name) ? "exit 1" : "exit 0",
    ])
  );
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "stub", private: true, scripts }, null, 2)
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

function runGates(cwd, stampDir, gates) {
  return spawnSync("node", [RUNNER, "--stamp", ...gates], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "",
      CENTRAID_GATE_STAMPS: "",
      CENTRAID_GATE_STAMP_DIR: stampDir,
    },
  });
}

test("a green run of the whole tier exits 0, stamps, and the next one skips", () => {
  const repo = stubRepo();
  const stamps = mkdtempSync(path.join(tmpdir(), "run-gates-stamps-"));
  try {
    const first = runGates(repo, stamps, STATIC_TIER);
    assert.equal(first.status, 0, `first run must exit 0:\n${first.stderr}`);
    assert.ok(
      existsSync(path.join(stamps, "static.json")),
      "a whole-tier green run must write the stamp"
    );
    const second = runGates(repo, stamps, STATIC_TIER);
    assert.equal(second.status, 0, `second run must exit 0:\n${second.stderr}`);
    assert.match(second.stderr, /⊘ static tier stamped/u);
    assert.match(second.stderr, /▶ 0 gates/u);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stamps, { recursive: true, force: true });
  }
});

test("a green run of a SUBSET of the tier exits 0 and stamps nothing", () => {
  const repo = stubRepo();
  const stamps = mkdtempSync(path.join(tmpdir(), "run-gates-stamps-"));
  try {
    const run = runGates(repo, stamps, [STATIC_TIER[0]]);
    assert.equal(run.status, 0, `a subset run must exit 0:\n${run.stderr}`);
    assert.equal(
      existsSync(path.join(stamps, "static.json")),
      false,
      "a subset run must not stamp the tier"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stamps, { recursive: true, force: true });
  }
});

test("a red run exits 1 and stamps nothing", () => {
  const repo = stubRepo([STATIC_TIER[1]]);
  const stamps = mkdtempSync(path.join(tmpdir(), "run-gates-stamps-"));
  try {
    const run = runGates(repo, stamps, STATIC_TIER);
    assert.equal(run.status, 1, "a failing gate must fail the run");
    assert.equal(
      existsSync(path.join(stamps, "static.json")),
      false,
      "a red run must not stamp the tier"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stamps, { recursive: true, force: true });
  }
});
