import assert from "node:assert/strict";
// oxlint-disable-next-line no-restricted-imports -- (#781) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; removal is registered at creation via t.after below.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { lintTsconfigs } from "./lint-tsconfigs.mjs";

const BASE = JSON.stringify({
  compilerOptions: { module: "esnext", moduleResolution: "bundler" },
});

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "centraid-tsconfigs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = { "tsconfig.base.json": BASE, ...files };
  for (const [rel, contents] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

const json = (value) => JSON.stringify(value, null, 2);
const noEmitConfig = json({
  extends: "../../tsconfig.base.json",
  compilerOptions: { noEmit: true },
  include: ["src/**/*"],
});

test("a compliant workspace produces no failures", (t) => {
  const root = fixture(t, {
    "packages/ok/tsconfig.json": noEmitConfig,
    "packages/ok/package.json": json({
      name: "ok",
      scripts: { typecheck: "tsc -p tsconfig.json" },
    }),
    "packages/ok/src/index.ts": "export const a = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root), []);
});

test("a tsconfig that does not extend a shared base is rejected", (t) => {
  const root = fixture(t, {
    "packages/bad/tsconfig.json": json({
      compilerOptions: { noEmit: true },
      include: ["src/**/*"],
    }),
    "packages/bad/src/index.ts": "export const a = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root), [
    "packages/bad/tsconfig.json: must extend a shared tsconfig base",
  ]);
});

test("baseUrl is rejected as removed by TypeScript 7", (t) => {
  const root = fixture(t, {
    "packages/bad/tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { noEmit: true, baseUrl: "." },
      include: ["src/**/*"],
    }),
    "packages/bad/src/index.ts": "export const a = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root), [
    "packages/bad/tsconfig.json: baseUrl is removed by TypeScript 7",
  ]);
});

test("a removed moduleResolution value is rejected", (t) => {
  const root = fixture(t, {
    "packages/bad/tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { noEmit: true, moduleResolution: "Node" },
      include: ["src/**/*"],
    }),
    "packages/bad/src/index.ts": "export const a = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root), [
    "packages/bad/tsconfig.json: moduleResolution Node is removed by TypeScript 7",
  ]);
});

test("a non-main tsconfig is checked for the same option rules", (t) => {
  const root = fixture(t, {
    "packages/ok/tsconfig.json": noEmitConfig,
    "packages/ok/tsconfig.build.json": json({
      compilerOptions: { baseUrl: "." },
    }),
    "packages/ok/package.json": json({ name: "ok", scripts: {} }),
    "packages/ok/src/index.ts": "export const a = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root).sort(), [
    "packages/ok/tsconfig.build.json: baseUrl is removed by TypeScript 7",
    "packages/ok/tsconfig.build.json: must extend a shared tsconfig base",
  ]);
});

test("an emitting program that packages its own source tests is rejected", (t) => {
  const root = fixture(t, {
    "packages/emit/tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { outDir: "dist" },
      include: ["src/**/*"],
    }),
    "packages/emit/package.json": json({ name: "emit", scripts: {} }),
    "packages/emit/src/index.ts": "export const a = 1;\n",
    "packages/emit/src/index.test.ts": "export const t = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root).sort(), [
    "packages/emit/tsconfig.json: emitting programs must exclude source tests",
    "packages/emit: source tests need a tsconfig.test.json program",
  ]);
});

test("an emitting program that excludes tests still needs a tsconfig.test.json", (t) => {
  const root = fixture(t, {
    "packages/emit/tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { outDir: "dist" },
      include: ["src/**/*"],
      exclude: ["src/**/*.test.ts"],
    }),
    "packages/emit/package.json": json({ name: "emit", scripts: {} }),
    "packages/emit/src/index.ts": "export const a = 1;\n",
    "packages/emit/src/index.test.ts": "export const t = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root), [
    "packages/emit: source tests need a tsconfig.test.json program",
  ]);
});

test("an emitting program with excluded tests and a test program passes", (t) => {
  const root = fixture(t, {
    "packages/emit/tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { outDir: "dist" },
      include: ["src/**/*"],
      exclude: ["src/**/*.test.ts"],
    }),
    "packages/emit/tsconfig.test.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { noEmit: true },
      include: ["src/**/*"],
    }),
    "packages/emit/package.json": json({
      name: "emit",
      scripts: {
        typecheck: "tsc -p tsconfig.json && tsc -p tsconfig.test.json",
      },
    }),
    "packages/emit/src/index.ts": "export const a = 1;\n",
    "packages/emit/src/index.test.ts": "export const t = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root), []);
});

test("a tsconfig.test.json that misses a source test is rejected", (t) => {
  const root = fixture(t, {
    "packages/part/tsconfig.json": noEmitConfig,
    "packages/part/tsconfig.test.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { noEmit: true },
      include: ["src/a.test.ts"],
    }),
    "packages/part/package.json": json({
      name: "part",
      scripts: { typecheck: "tsc -p tsconfig.test.json" },
    }),
    "packages/part/src/a.test.ts": "export const a = 1;\n",
    "packages/part/src/b.test.ts": "export const b = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root), [
    "packages/part/tsconfig.test.json: must include every source test",
  ]);
});

test("a package.json typecheck that ignores tsconfig.test.json is rejected", (t) => {
  const root = fixture(t, {
    "packages/pkg/tsconfig.json": noEmitConfig,
    "packages/pkg/tsconfig.test.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: { noEmit: true },
      include: ["src/**/*"],
    }),
    "packages/pkg/package.json": json({
      name: "pkg",
      scripts: { typecheck: "tsc -p tsconfig.json" },
    }),
    "packages/pkg/src/a.test.ts": "export const a = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root), [
    "packages/pkg/package.json: typecheck must target tsconfig.test.json",
  ]);
});

test("apps/* workspaces are checked, not only packages/*", (t) => {
  const root = fixture(t, {
    "apps/thing/tsconfig.json": json({
      compilerOptions: { noEmit: true },
      include: ["src/**/*"],
    }),
    "apps/thing/src/index.ts": "export const a = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root), [
    "apps/thing/tsconfig.json: must extend a shared tsconfig base",
  ]);
});

test("a workspace directory with no tsconfig.json is skipped", (t) => {
  const root = fixture(t, {
    "packages/none/package.json": json({ name: "none" }),
    "packages/none/src/index.ts": "export const a = 1;\n",
  });
  assert.deepEqual(lintTsconfigs(root), []);
});
