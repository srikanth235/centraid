import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

/**
 * Guard tests for the npm publish step (issue #656 Layer 1F).
 *
 * `publish.mjs` is a top-level `main()` with no exported seam, so the refusal
 * contract is exercised as a subprocess. Every case below aborts *before* the
 * first `npm publish` spawn, so no test can reach the network or the registry.
 */

const scriptDir = import.meta.dirname;
const root = path.resolve(scriptDir, "../..");
const script = path.join(scriptDir, "publish.mjs");

/** Run publish.mjs with a deliberately token-free environment. */
function runPublish(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NPM_TOKEN;
  delete env.NODE_AUTH_TOKEN;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

test("refuses to publish when --require-token is set but no token is present", () => {
  const result = runPublish([
    "--require-token",
    "--pack-dir",
    path.join(scriptDir),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NPM_TOKEN \/ NODE_AUTH_TOKEN required/u);
});

test("refuses to publish when the pack dir does not exist", () => {
  const missing = path.join(root, "artifacts", "npm-packs-absent-fixture");
  const result = runPublish(["--pack-dir", missing]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pack dir missing/u);
  assert.ok(
    result.stderr.includes(missing),
    `expected the missing path in stderr, got: ${result.stderr}`
  );
});

test("refuses to publish when the pack dir holds no tarballs", () => {
  // scripts/gateway-npm exists and provably contains no .tgz files.
  const result = runPublish(["--pack-dir", scriptDir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no \.tgz files in pack dir/u);
});

test("the missing-token refusal outranks the missing-pack-dir refusal", () => {
  const missing = path.join(root, "artifacts", "npm-packs-absent-fixture");
  const result = runPublish(["--require-token", "--pack-dir", missing]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NPM_TOKEN \/ NODE_AUTH_TOKEN required/u);
  assert.doesNotMatch(result.stderr, /pack dir missing/u);
});
