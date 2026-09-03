import assert from "node:assert/strict";
import test from "node:test";

import {
  globToRegExp,
  lintTurboOutputs,
  stripJsonComments,
  trackedMatches,
  workspaceDirs,
} from "./lint-turbo-cache.mjs";

const DIRS = ["packages/tunnel", "apps/web"];

test("globToRegExp: ** crosses separators, * does not", () => {
  assert.equal(globToRegExp("a/**").test("a/b/c.js"), true);
  assert.equal(globToRegExp("a/**").test("a"), true);
  assert.equal(globToRegExp("a/*.node").test("a/x.node"), true);
  assert.equal(globToRegExp("a/*.node").test("a/b/x.node"), false);
  assert.equal(globToRegExp("a/*.node").test("a/Cargo.toml"), false);
});

test("globToRegExp: literal dots are not wildcards", () => {
  assert.equal(globToRegExp("a/x.node").test("a/xYnode"), false);
});

test("trackedMatches: a gitignored artifact glob matches nothing tracked", () => {
  assert.deepEqual(
    trackedMatches("native/*.node", DIRS, [
      "packages/tunnel/native/Cargo.toml",
      "packages/tunnel/native/build.rs",
    ]),
    []
  );
});

test("trackedMatches: a committed artifact declared as an output is caught", () => {
  assert.deepEqual(
    trackedMatches("src/generated/centraid_web_iroh_bg.wasm", DIRS, [
      "apps/web/src/generated/centraid_web_iroh_bg.wasm",
    ]),
    ["apps/web/src/generated/centraid_web_iroh_bg.wasm"]
  );
});

test("trackedMatches: turbo's negation entries are not outputs", () => {
  assert.deepEqual(
    trackedMatches("!dist/keep.txt", DIRS, ["apps/web/dist/keep.txt"]),
    []
  );
});

test("lintTurboOutputs: reports the task and the offending glob", () => {
  const errors = lintTurboOutputs(
    { tasks: { build: { outputs: ["src/generated/x.wasm"] } } },
    DIRS,
    ["apps/web/src/generated/x.wasm"]
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /task `build`/u);
  assert.match(errors[0], /src\/generated\/x\.wasm/u);
});

test("lintTurboOutputs: a task with no outputs is fine", () => {
  assert.deepEqual(
    lintTurboOutputs({ tasks: { typecheck: { outputs: [] } } }, DIRS, ["a"]),
    []
  );
});

test("workspaceDirs: accepts both the array and the object form", () => {
  const listDir = (dir) => (dir === "packages" ? ["core", "vault"] : ["web"]);
  assert.deepEqual(workspaceDirs(["packages/*", "apps/*"], listDir), [
    "packages/core",
    "packages/vault",
    "apps/web",
  ]);
  assert.deepEqual(workspaceDirs({ packages: ["packages/*"] }, listDir), [
    "packages/core",
    "packages/vault",
  ]);
});

test("workspaceDirs: refuses to pass vacuously with no workspaces", () => {
  assert.throws(() => workspaceDirs({}, () => []), /no workspaces/u);
});

test("stripJsonComments: keeps comment-looking text inside strings", () => {
  const parsed = JSON.parse(
    stripJsonComments('{ "a": "http://x", // trailing\n "b": 1 }')
  );
  assert.deepEqual(parsed, { a: "http://x", b: 1 });
});
