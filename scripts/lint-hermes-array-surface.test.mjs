import assert from "node:assert/strict";
// oxlint-disable-next-line no-restricted-imports -- (#781) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; removal is registered at creation via t.after below.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runHermesArraySurface } from "./lint-hermes-array-surface.mjs";

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "centraid-hermes-surface-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const PKG = (name) => JSON.stringify({ name });

test("flags a banned call in a package the mobile bundle reaches", (t) => {
  const root = fixture(t, {
    "packages/lib/package.json": PKG("@centraid/lib"),
    "packages/lib/src/index.ts":
      "export const rank = (r: number[]) => r.toSorted();\n",
    "apps/mobile/package.json": PKG("@centraid/mobile"),
    "apps/mobile/src/App.ts":
      'import { rank } from "@centraid/lib";\nexport default rank;\n',
  });

  const { violations } = runHermesArraySurface(root);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, "packages/lib/src/index.ts");
  assert.equal(violations[0].property, "toSorted");
});

test("ignores the same call in a package nothing on the phone imports", (t) => {
  const root = fixture(t, {
    "packages/server/package.json": PKG("@centraid/server"),
    "packages/server/src/index.ts":
      "export const rank = (r: number[]) => r.toSorted();\n",
    "apps/mobile/package.json": PKG("@centraid/mobile"),
    "apps/mobile/src/App.ts": "export default 1;\n",
  });

  assert.deepEqual(runHermesArraySurface(root).violations, []);
});

test("does not follow a type-only import, which ships no code", (t) => {
  const root = fixture(t, {
    "packages/types/package.json": PKG("@centraid/types"),
    "packages/types/src/index.ts":
      "export type Row = number;\nexport const dead = (r: number[]) => r.toReversed();\n",
    "apps/mobile/package.json": PKG("@centraid/mobile"),
    "apps/mobile/src/App.ts":
      'import type { Row } from "@centraid/types";\nexport const x: Row = 1;\n',
  });

  assert.deepEqual(runHermesArraySurface(root).violations, []);
});

test("reads the AST, so prose naming the method is not a violation", (t) => {
  const root = fixture(t, {
    "apps/mobile/package.json": PKG("@centraid/mobile"),
    "apps/mobile/src/App.ts":
      '// toSorted is what we used to call here.\nexport const note = ".toSorted()";\nexport default note;\n',
  });

  assert.deepEqual(runHermesArraySurface(root).violations, []);
});

test("skips tests, which run in Node and never reach a device", (t) => {
  const root = fixture(t, {
    "apps/mobile/package.json": PKG("@centraid/mobile"),
    "apps/mobile/src/App.ts": "export default 1;\n",
    "apps/mobile/src/App.test.ts": "export const r = [1].toSorted();\n",
  });

  assert.deepEqual(runHermesArraySurface(root).violations, []);
});

test("flags the one method the engine lacks and leaves the ones it ships", (t) => {
  const root = fixture(t, {
    "apps/mobile/package.json": PKG("@centraid/mobile"),
    "apps/mobile/src/App.ts": [
      "export const a = (r: number[]) => r.toReversed();",
      "export const b = (r: number[]) => r.toSpliced(0, 1);",
      "export const c = (r: number[]) => r.findLast(Boolean);",
      "export const d = (r: number[]) => r.findLastIndex(Boolean);",
      "export const e = (r: number[]) => r.toSorted();",
    ].join("\n"),
  });

  assert.deepEqual(
    runHermesArraySurface(root).violations.map((v) => v.property),
    ["toSorted"]
  );
});
