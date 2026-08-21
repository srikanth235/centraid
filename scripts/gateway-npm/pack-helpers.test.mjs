import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNpmInstallArgs,
  defaultInstallPrefix,
  formatPostInstallMessage,
  minNodeMajorFromEngines,
  nodeVersionSatisfies,
  parseInstallArgs,
  rewriteWorkspaceDependencies,
  topologicalPublishOrder,
} from "./pack-helpers.mjs";

test("rewriteWorkspaceDependencies maps workspace:* to versions and clears private", () => {
  const { packageJson, rewrote } = rewriteWorkspaceDependencies(
    {
      name: "@centraid/server",
      private: true,
      dependencies: {
        "@centraid/core/protocol": "workspace:*",
        sharp: "^0.35.3",
      },
      devDependencies: {
        typescript: "catalog:",
      },
      scripts: { prepack: "bun run build", test: "vitest" },
    },
    { "@centraid/core/protocol": "0.1.0" }
  );
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.dependencies["@centraid/core/protocol"], "0.1.0");
  assert.equal(packageJson.dependencies.sharp, "^0.35.3");
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.scripts?.prepack, undefined);
  assert.equal(packageJson.scripts?.test, "vitest");
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
  assert.ok(rewrote.includes("dependencies:@centraid/core/protocol"));
});

test("rewriteWorkspaceDependencies throws on missing workspace package", () => {
  assert.throws(
    () =>
      rewriteWorkspaceDependencies(
        {
          name: "@centraid/x",
          dependencies: { "@centraid/missing": "workspace:*" },
        },
        {}
      ),
    /No published version/u
  );
});

test("topologicalPublishOrder places deps before dependents", () => {
  const pkgs = {
    protocol: {
      name: "@centraid/core/protocol",
      version: "0.1.0",
      dependencies: {},
    },
    gateway: {
      name: "@centraid/server",
      version: "0.1.0",
      dependencies: { "@centraid/core/protocol": "workspace:*" },
    },
  };
  const order = topologicalPublishOrder(
    ["gateway", "protocol"],
    (dir) => pkgs[dir]
  );
  assert.deepEqual(order, ["protocol", "gateway"]);
});

test("parseInstallArgs reads OpenClaw-like flags", () => {
  const a = parseInstallArgs([
    "--prefix",
    "/tmp/c",
    "--version",
    "0.1.0",
    "--from-pack-dir",
    "./packs",
    "--dry-run",
    "--with-service",
  ]);
  assert.equal(a.prefix, "/tmp/c");
  assert.equal(a.global, false);
  assert.equal(a.version, "0.1.0");
  assert.equal(a.fromPackDir, "./packs");
  assert.equal(a.dryRun, true);
  assert.equal(a.withService, true);
});

test("parseInstallArgs rejects unknown flags", () => {
  assert.throws(() => parseInstallArgs(["--docker"]), /Unknown flag/u);
});

test("buildNpmInstallArgs registry vs pack dir", () => {
  assert.deepEqual(
    buildNpmInstallArgs({ version: "0.2.0", fromPackDir: null }),
    ["@centraid/server@0.2.0"]
  );
  assert.deepEqual(
    buildNpmInstallArgs({
      version: "latest",
      fromPackDir: "/packs",
      packFiles: ["/packs/a.tgz", "/packs/b.tgz"],
    }),
    ["/packs/a.tgz", "/packs/b.tgz"]
  );
  assert.throws(
    () =>
      buildNpmInstallArgs({
        version: "latest",
        fromPackDir: "/empty",
        packFiles: [],
      }),
    /No pack tarballs/u
  );
});

test("formatPostInstallMessage never implies silent service", () => {
  const msg = formatPostInstallMessage({
    bin: "centraid-gateway",
    prefix: "/home/u/.centraid",
    withService: false,
  });
  assert.match(msg, /serve --data-dir/u);
  assert.match(msg, /service install/u);
  assert.match(msg, /Optional OS service/u);
  assert.doesNotMatch(msg, /installed the OS service/iu);
});

test("nodeVersionSatisfies and engines parse", () => {
  assert.equal(minNodeMajorFromEngines(">=22.5"), 22);
  assert.equal(nodeVersionSatisfies("v22.23.1", 22), true);
  assert.equal(nodeVersionSatisfies("v20.0.0", 22), false);
  assert.equal(defaultInstallPrefix("/Users/me"), "/Users/me/.centraid");
});
