// Fail-path proof for `bun run check:reachability` (issue #750).
//
// Drives the analyzer against synthetic workspaces via its injectable root.
// Uses `mkdtempSync` rather than `@centraid/test-kit`'s `tempDir()` for the
// same reason as scripts/lint-protocol-routes.test.mjs: this lane runs under
// `node --test`, where the kit's vitest hooks throw.
import assert from "node:assert/strict";
// oxlint-disable-next-line no-restricted-imports -- (#781) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; removal is registered at creation via t.after below.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isTestPath,
  runShareReachability,
} from "./check-share-reachability.mjs";

const CONFIG = { modules: ["packages/core/src/share/*.ts"], allowlist: [] };

/** Build a throwaway repo root containing `files` (relative path → contents). */
function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "centraid-share-reach-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const withManifests = {
    "packages/core/package.json": '{ "name": "@fix/core" }\n',
    "packages/other/package.json": '{ "name": "@fix/other" }\n',
    "packages/mid/package.json": '{ "name": "@fix/mid" }\n',
    ...files,
  };
  for (const [rel, contents] of Object.entries(withManifests)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

const CAP = "export function capability() {\n  return 1;\n}\n";
const BARREL = 'export { capability } from "./share/cap.js";\n';

test("a barrel-laundered export whose only caller is a test file fails", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/index.ts": BARREL,
    "packages/other/src/use.test.ts":
      'import { capability } from "@fix/core";\ncapability();\n',
  });
  const { offenses } = runShareReachability(root, CONFIG);
  assert.equal(offenses.length, 1);
  assert.equal(
    offenses[0].capability,
    "packages/core/src/share/cap.ts#capability"
  );
  assert.match(
    offenses[0].why,
    /test-only reachers: packages\/other\/src\/use\.test\.ts/u
  );
});

test("a production caller importing through the barrel passes", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/index.ts": BARREL,
    "packages/other/src/use.ts":
      'import { capability } from "@fix/core";\ncapability();\n',
  });
  assert.deepEqual(runShareReachability(root, CONFIG).offenses, []);
});

test("a production caller importing the module directly passes", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/serve.ts":
      'import { capability } from "./share/cap.js";\ncapability();\n',
  });
  assert.deepEqual(runShareReachability(root, CONFIG).offenses, []);
});

test("an export with no reachers at all fails, even when re-exported by the barrel", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/index.ts": BARREL,
  });
  const { offenses } = runShareReachability(root, CONFIG);
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].why, /no reachers at all/u);
});

// Same-file rule: a value-position use inside the declaring production module
// is a production reach (knip's `ignoreExportsUsedInFile` convention). The
// gate still catches capabilities invoked nowhere — in-file or out.
test("a same-file value use inside the production declaring module is a production reacher", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": `${CAP}capability();\n`,
    "packages/core/src/index.ts": BARREL,
  });
  assert.deepEqual(runShareReachability(root, CONFIG).offenses, []);
});

test("a same-file value use behind `export { local as exported }` counts under the exported name", (t) => {
  const declared =
    "function capability() {\n  return 1;\n}\nexport { capability as sharedCapability };\n";
  const used = fixture(t, {
    "packages/core/src/share/cap.ts": `${declared}capability();\n`,
  });
  assert.deepEqual(runShareReachability(used, CONFIG).offenses, []);

  const unused = fixture(t, { "packages/core/src/share/cap.ts": declared });
  const { offenses } = runShareReachability(unused, CONFIG);
  assert.equal(offenses.length, 1);
  assert.equal(
    offenses[0].capability,
    "packages/core/src/share/cap.ts#sharedCapability"
  );
});

// Regression guard: the usage walk must not count a declaration's own name as
// a use, or every export would look same-file reached.
test("a declaration with no use beyond its own declaration still fails", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": `${CAP}export const CAP_LIMIT = 4;\nexport class CapBox {}\n`,
    "packages/core/src/index.ts": BARREL,
  });
  const { offenses } = runShareReachability(root, CONFIG);
  assert.deepEqual(offenses.map((o) => o.capability).sort(), [
    "packages/core/src/share/cap.ts#CAP_LIMIT",
    "packages/core/src/share/cap.ts#CapBox",
    "packages/core/src/share/cap.ts#capability",
  ]);
  for (const offense of offenses) assert.match(offense.why, /no reachers/u);
});

test("a same-file use in a type position only does not rescue the capability", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": `${CAP}export type CapFn = typeof capability;\n`,
    "packages/core/src/index.ts": BARREL,
  });
  const { offenses } = runShareReachability(root, CONFIG);
  assert.equal(offenses.length, 1);
  assert.equal(
    offenses[0].capability,
    "packages/core/src/share/cap.ts#capability"
  );
});

test("a same-file use inside a test module does not rescue a same-named production capability", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/share/other.test.ts": `${CAP}capability();\n`,
    "packages/core/src/index.ts": BARREL,
  });
  const { offenses } = runShareReachability(root, CONFIG);
  assert.equal(offenses.length, 1);
  assert.equal(
    offenses[0].capability,
    "packages/core/src/share/cap.ts#capability"
  );
});

test("a production `import type` caller is type-only and fails", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/index.ts": BARREL,
    "packages/other/src/use.ts":
      'import type { capability } from "@fix/core";\nexport function f(x: typeof capability) {\n  return x;\n}\n',
  });
  const { offenses } = runShareReachability(root, CONFIG);
  assert.equal(offenses.length, 1);
  assert.match(
    offenses[0].why,
    /type-only reachers: packages\/other\/src\/use\.ts/u
  );
});

test("a value import used only in a type position is type-only and fails", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/index.ts": BARREL,
    "packages/other/src/use.ts":
      'import { capability } from "@fix/core";\nexport function f(x: typeof capability) {\n  return x;\n}\n',
  });
  const { offenses } = runShareReachability(root, CONFIG);
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].why, /type-only reachers/u);
});

test("`export *` barrels are followed to the production caller", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/share/index.ts": 'export * from "./cap.js";\n',
    "packages/core/src/index.ts": 'export * from "./share/index.js";\n',
    "packages/other/src/use.ts":
      'import { capability } from "@fix/core";\ncapability();\n',
  });
  assert.deepEqual(runShareReachability(root, CONFIG).offenses, []);
});

test("an import-then-re-export site is laundering, not a caller", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/index.ts": BARREL,
    "packages/mid/src/index.ts":
      'import { capability } from "@fix/core";\nexport { capability };\n',
  });
  const { offenses } = runShareReachability(root, CONFIG);
  assert.equal(offenses.length, 1);
  assert.match(offenses[0].why, /no reachers at all/u);
});

test("a production caller behind an import-then-re-export chain still counts", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/index.ts": BARREL,
    "packages/mid/src/index.ts":
      'import { capability } from "@fix/core";\nexport { capability };\n',
    "packages/other/src/use.ts":
      'import { capability } from "@fix/mid";\ncapability();\n',
  });
  assert.deepEqual(runShareReachability(root, CONFIG).offenses, []);
});

test("a namespace import with a value member access is a production caller", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/index.ts": BARREL,
    "packages/other/src/use.ts":
      'import * as core from "@fix/core";\ncore.capability();\n',
  });
  assert.deepEqual(runShareReachability(root, CONFIG).offenses, []);
});

test("type-only exports are not capabilities and are exempt", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts":
      "export type Shape = { id: string };\nexport interface Frame {\n  id: string;\n}\n",
    "packages/core/src/index.ts":
      'export type { Shape, Frame } from "./share/cap.js";\n',
  });
  const result = runShareReachability(root, CONFIG);
  assert.deepEqual(result.offenses, []);
  assert.equal(result.targetCount, 0);
});

test("scoped test/fixture modules are not targets", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.test-fixtures.ts": CAP,
    "packages/core/src/share/cap.test.ts": CAP,
  });
  assert.equal(runShareReachability(root, CONFIG).targetCount, 0);
});

test("an allowlist entry with a reason suppresses the offense", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/index.ts": BARREL,
  });
  const result = runShareReachability(root, {
    ...CONFIG,
    allowlist: [
      {
        capability: "packages/core/src/share/cap.ts#capability",
        reason: "TODO(#750): fixture exception",
      },
    ],
  });
  assert.deepEqual(result.offenses, []);
  assert.deepEqual(result.staleAllowlist, []);
});

test("a stale allowlist entry is reported so the list only shrinks", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
    "packages/core/src/index.ts": BARREL,
    "packages/other/src/use.ts":
      'import { capability } from "@fix/core";\ncapability();\n',
  });
  const result = runShareReachability(root, {
    ...CONFIG,
    allowlist: [
      {
        capability: "packages/core/src/share/cap.ts#capability",
        reason: "TODO(#750): now fixed",
      },
    ],
  });
  assert.deepEqual(result.offenses, []);
  assert.deepEqual(result.staleAllowlist, [
    "packages/core/src/share/cap.ts#capability",
  ]);
});

test("an allowlist entry without a reason is a config error", (t) => {
  const root = fixture(t, {
    "packages/core/src/share/cap.ts": CAP,
  });
  const result = runShareReachability(root, {
    ...CONFIG,
    allowlist: [
      { capability: "packages/core/src/share/cap.ts#capability", reason: " " },
    ],
  });
  assert.equal(result.configErrors.length, 1);
  assert.match(result.configErrors[0], /non-empty reason/u);
});

test("test classification follows the TESTING.md path conventions", () => {
  for (const p of [
    "packages/server/src/serve/vault-plane.test.ts",
    "packages/server/src/serve/gateway-db-lock.integration.test.ts",
    "packages/client/src/web-control-sessions.contract.test.ts",
    "apps/web/tests/e2e/share.spec.ts",
    "packages/server/src/serve/peer-give.test-fixtures.ts",
    "packages/server/src/serve/outbox-executor-test-kit.ts",
    "packages/vault/src/share/placement-fixture.ts",
    "packages/test-kit/src/sqlite.ts",
    "tests/perf/commons.perf.test.ts",
    "packages/server/benchmarks/low-end.ts",
  ]) {
    assert.equal(isTestPath(p), true, `${p} should classify as test`);
  }
  for (const p of [
    "packages/vault/src/share/placement.ts",
    "packages/server/src/serve/peer-link-client.ts",
    "apps/desktop/src/main.ts",
  ]) {
    assert.equal(isTestPath(p), false, `${p} should classify as production`);
  }
});
