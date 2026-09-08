import assert from "node:assert/strict";
import test from "node:test";

import {
  GLOBAL_HASH_INPUTS,
  decideFloor,
  globalHashInputsIn,
  parseDiffOutput,
  renderFloorDecision,
} from "./turbo-floor.mjs";

test("the lockfile, root manifest, turbo config and toolchain move the global hash", () => {
  for (const input of GLOBAL_HASH_INPUTS) {
    assert.deepEqual(globalHashInputsIn([input]), [input], input);
  }
  assert.deepEqual(globalHashInputsIn(["rust-toolchain.toml"]), [
    "rust-toolchain.toml",
  ]);
  assert.deepEqual(globalHashInputsIn(["rust-toolchain"]), ["rust-toolchain"]);
  assert.deepEqual(globalHashInputsIn([".github/actions/setup/action.yml"]), [
    ".github/actions/setup/action.yml",
  ]);
});

test("a package-local package.json is NOT a global-hash input", () => {
  // This is the case the floor exists to catch: one package's hash moves, its
  // dependents miss, and 3 of 13 tasks still hit. Waiving it would waive most
  // of the repo's PRs.
  assert.deepEqual(globalHashInputsIn(["packages/core/package.json"]), []);
  assert.deepEqual(globalHashInputsIn(["apps/web/turbo.json"]), []);
  assert.deepEqual(globalHashInputsIn(["packages/core/src/index.ts"]), []);
  assert.deepEqual(globalHashInputsIn([]), []);
});

test("every global-hash mover in a mixed diff is named, once", () => {
  assert.deepEqual(
    globalHashInputsIn([
      "packages/core/src/a.ts",
      "bun.lock",
      "package.json",
      "bun.lock",
    ]),
    ["bun.lock", "package.json"]
  );
});

test("parseDiffOutput drops blanks and trims", () => {
  assert.deepEqual(parseDiffOutput("a\n\n  b  \n"), ["a", "b"]);
  assert.deepEqual(parseDiffOutput(""), []);
  assert.deepEqual(parseDiffOutput(undefined), []);
});

test("an ordinary diff enforces the floor and says why", () => {
  const decision = decideFloor({
    files: ["packages/core/src/index.ts"],
    minHitRate: 0.15,
  });
  assert.equal(decision.enforce, true);
  assert.deepEqual(decision.movers, []);
  assert.match(decision.reason, /cache regression/u);
  assert.match(renderFloorDecision(decision), /Enforced at 15%/u);
});

test("a lockfile bump waives the floor and names the file", () => {
  const decision = decideFloor({
    files: ["bun.lock", "package.json"],
    minHitRate: 0.15,
  });
  assert.equal(decision.enforce, false);
  assert.deepEqual(decision.movers, ["bun.lock", "package.json"]);
  assert.match(decision.reason, /GLOBAL hash/u);
  const rendered = renderFloorDecision(decision);
  assert.match(rendered, /Waived this run/u);
  assert.match(rendered, /`bun\.lock`/u);
  assert.match(rendered, /no flag or environment variable/u);
});

test("an unreadable diff waives loudly rather than reding a checkout depth", () => {
  const decision = decideFloor({ files: null, minHitRate: 0.15 });
  assert.equal(decision.enforce, false);
  assert.deepEqual(decision.movers, []);
  assert.match(decision.reason, /could not be read/u);
});
