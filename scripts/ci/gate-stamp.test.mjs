// A stamp may only ever spare a re-run, never change a verdict (#988).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
// oxlint-disable-next-line no-restricted-imports -- (#988) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; every directory below is removed in its own finally. Same pattern as scripts/check-ledgers.test.mjs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isFresh,
  record,
  stampDir,
  stampKey,
  stampsEnabled,
  STATIC_TIER,
  workingTreeOid,
} from "./gate-stamp.mjs";

/** A throwaway repo so nothing here reads or writes the real one. */
function scratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-stamp-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return { dir, git };
}

function withEnv(overrides, body) {
  const saved = { ...process.env };
  Object.assign(process.env, overrides);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
  }
  try {
    return body();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("the key moves with an uncommitted edit and with the base", () => {
  const { dir, git } = scratchRepo();
  try {
    const before = workingTreeOid(dir);
    writeFileSync(path.join(dir, "a.txt"), "two\n");
    assert.notEqual(
      workingTreeOid(dir),
      before,
      "an unstaged edit must move the tree oid"
    );
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    assert.equal(workingTreeOid(dir), before, "reverting must restore it");
    writeFileSync(path.join(dir, "b.txt"), "new\n");
    assert.notEqual(
      workingTreeOid(dir),
      before,
      "an untracked file must move it"
    );
    // The caller's index is never disturbed.
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: dir,
        encoding: "utf8",
      }).trim(),
      "?? b.txt"
    );
    git("checkout", "-q", "-b", "side");
    const key = stampKey(dir);
    assert.equal(
      key.base,
      "none",
      "no origin/main resolves to a base of 'none'"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a recorded stamp is fresh for its key and stale for any other", () => {
  const store = mkdtempSync(path.join(tmpdir(), "gate-stamp-store-"));
  try {
    withEnv(
      {
        CENTRAID_GATE_STAMP_DIR: store,
        CI: undefined,
        CENTRAID_GATE_STAMPS: undefined,
      },
      () => {
        assert.equal(stampDir(), path.resolve(store));
        const key = { tree: "a".repeat(40), base: "b".repeat(40) };
        assert.equal(
          isFresh("static", key),
          false,
          "an unrecorded tier is never fresh"
        );
        record("static", key);
        assert.equal(isFresh("static", key), true);
        assert.equal(
          isFresh("static", { ...key, tree: "c".repeat(40) }),
          false,
          "a moved tree is stale"
        );
        assert.equal(
          isFresh("static", { ...key, base: "c".repeat(40) }),
          false,
          "a moved base is stale"
        );
        assert.equal(
          isFresh("governance", key),
          false,
          "tiers do not share a stamp"
        );
      }
    );
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test("CI reads no stamp and writes none", () => {
  const store = mkdtempSync(path.join(tmpdir(), "gate-stamp-ci-"));
  try {
    const key = { tree: "a".repeat(40), base: "b".repeat(40) };
    withEnv({ CENTRAID_GATE_STAMP_DIR: store, CI: undefined }, () =>
      record("static", key)
    );
    withEnv({ CENTRAID_GATE_STAMP_DIR: store, CI: "true" }, () => {
      assert.equal(stampsEnabled(), false);
      assert.equal(
        isFresh("static", key),
        false,
        "CI must recompute even over a recorded tree"
      );
      record("static", { tree: "z".repeat(40), base: "z".repeat(40) });
    });
    withEnv({ CENTRAID_GATE_STAMP_DIR: store, CI: undefined }, () => {
      assert.equal(
        isFresh("static", key),
        true,
        "a CI run must not have overwritten the stamp"
      );
    });
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test("CENTRAID_GATE_STAMPS=0 disables the skip", () => {
  const store = mkdtempSync(path.join(tmpdir(), "gate-stamp-off-"));
  try {
    const key = { tree: "a".repeat(40), base: "b".repeat(40) };
    withEnv({ CENTRAID_GATE_STAMP_DIR: store, CI: undefined }, () =>
      record("static", key)
    );
    withEnv(
      {
        CENTRAID_GATE_STAMP_DIR: store,
        CI: undefined,
        CENTRAID_GATE_STAMPS: "0",
      },
      () => {
        assert.equal(isFresh("static", key), false);
      }
    );
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test("the static tier holds only tree-determined gates named by check:push", () => {
  const pkg = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../../package.json"),
      "utf8"
    )
  );
  const checkPush = pkg.scripts["check:push"].split(/\s+/u);
  assert.ok(
    checkPush.includes("--stamp"),
    "check:push must opt into the stamp"
  );
  for (const gate of STATIC_TIER) {
    assert.ok(
      checkPush.includes(gate),
      `${gate} is in the static tier but not in check:push`
    );
  }
});
