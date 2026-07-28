#!/usr/bin/env node
// Workspace tsconfig consistency check (#619).
//
// Every workspace tsconfig had drifted into its own shape: some emitted test
// files into a published `dist/`, some kept compiler options TypeScript 7 has
// removed (which silently disables the type-aware lint pass in
// scripts/lint-types.sh), and two packages excluded their tests from every TS
// program so those tests were never typechecked at all. None of that is
// visible in review — a tsconfig diff always looks locally reasonable — so it
// is asserted here instead of documented and hoped for.
//
// The rules below are invariants, not a style guide. Each one exists because
// it was violated in a way that had a consequence:
//
//   extends-a-base      An orphan config silently opts out of every strictness
//                       flag in tsconfig.base.json.
//   no-removed-options  `baseUrl` and `moduleResolution: node/node10/classic`
//                       were removed in TS7. oxlint-tsgolint refuses to build a
//                       program for such a config, so the type-aware rules
//                       report nothing for that package (#619).
//   emit-excludes-tests A config that emits (`noEmit: false` or an `outDir`)
//                       and does not exclude `*.test.*` compiles its tests into
//                       `dist/`. packages/blob-format and packages/design-tokens
//                       are both `"private": false` with `"files": ["dist"]`, so
//                       their test artifacts were being published.
//   tests-are-checked   A package whose tests are excluded from its only
//                       tsconfig never typechecks them. packages/cli and
//                       packages/protocol each had five such test files.
//
// Run via `bun run lint:tsconfigs` (part of check:pr).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const { join, resolve } = path;

const ROOT = resolve(import.meta.dirname, "..");

/** Parse a tsconfig with comments/trailing commas, the way tsc itself does. */
function readTsconfig(relPath) {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  const { config, error } = ts.parseConfigFileTextToJson(relPath, text);
  if (error) {
    const message = ts.flattenDiagnosticMessageText(error.messageText, " ");
    throw new Error(`${relPath}: ${message}`);
  }
  return config ?? {};
}

/** Every workspace directory under packages/ and apps/. */
function workspaces() {
  const dirs = [];
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(ROOT, group), {
      withFileTypes: true,
    })) {
      if (
        name.isDirectory() &&
        existsSync(join(ROOT, group, name.name, "package.json"))
      ) {
        dirs.push(`${group}/${name.name}`);
      }
    }
  }
  return dirs.sort();
}

/** All tsconfig*.json files directly inside a workspace. */
function tsconfigsIn(workspace) {
  return readdirSync(join(ROOT, workspace))
    .filter((f) => /^tsconfig(?<variant>\..+)?\.json$/u.test(f))
    .sort()
    .map((f) => `${workspace}/${f}`);
}

// Options TypeScript 7 removed. Keeping any of these makes the config
// unloadable by oxlint-tsgolint, which silently costs the package its
// type-aware lint coverage.
const REMOVED_OPTIONS = {
  baseUrl:
    "removed in TS7 — `paths` already resolve relative to the tsconfig, so drop it",
  moduleResolution: {
    node: 'removed in TS7 — use "NodeNext" (or "Bundler" for bundled apps)',
    node10: 'removed in TS7 — use "NodeNext" (or "Bundler" for bundled apps)',
    classic: 'removed in TS7 — use "NodeNext" (or "Bundler" for bundled apps)',
  },
};

const TEST_GLOB = /\*\.test\.|\*\*\/\*\.(?<kind>test|spec)\./u;

const problems = [];
const fail = (file, rule, message) => problems.push({ file, rule, message });

for (const workspace of workspaces()) {
  const configs = tsconfigsIn(workspace);
  if (configs.length === 0) continue;

  const pkg = JSON.parse(
    readFileSync(join(ROOT, workspace, "package.json"), "utf8")
  );

  // Does this workspace actually have test sources?
  const hasTests = (function walk(dir) {
    if (!existsSync(dir)) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) return true;
      } else if (/\.(?<kind>test|spec)\.tsx?$/u.test(entry.name)) {
        return true;
      }
    }
    return false;
  })(join(ROOT, workspace, "src"));

  let anyConfigIncludesTests = false;

  for (const file of configs) {
    const config = readTsconfig(file);
    const options = config.compilerOptions ?? {};

    // --- extends-a-base -------------------------------------------------
    if (!config.extends) {
      fail(
        file,
        "extends-a-base",
        "must extend a root tsconfig.*.json — an orphan config opts out of the repo's strictness flags"
      );
    }

    // --- no-removed-options ---------------------------------------------
    if (options.baseUrl !== undefined) {
      fail(
        file,
        "no-removed-options",
        `compilerOptions.baseUrl is ${REMOVED_OPTIONS.baseUrl}`
      );
    }
    const resolution = String(options.moduleResolution ?? "").toLowerCase();
    if (resolution && REMOVED_OPTIONS.moduleResolution[resolution]) {
      fail(
        file,
        "no-removed-options",
        `compilerOptions.moduleResolution "${options.moduleResolution}" is ${REMOVED_OPTIONS.moduleResolution[resolution]}`
      );
    }

    // --- emit-excludes-tests --------------------------------------------
    const emits = options.noEmit === false || options.outDir !== undefined;
    const excludesTests = (config.exclude ?? []).some((p) => TEST_GLOB.test(p));
    if (emits && !excludesTests) {
      const published = pkg.private === false;
      fail(
        file,
        "emit-excludes-tests",
        `emits to ${options.outDir ?? "dist"} but does not exclude "src/**/*.test.ts"` +
          (published
            ? ` — ${pkg.name} is published, so compiled tests ship to consumers`
            : " — compiled tests land in dist/")
      );
    }

    // Track whether SOME config puts the tests in a program.
    if (!excludesTests && (config.include ?? []).length > 0) {
      anyConfigIncludesTests = true;
    }
  }

  // --- tests-are-checked -------------------------------------------------
  if (hasTests && !anyConfigIncludesTests) {
    fail(
      `${workspace}/tsconfig.json`,
      "tests-are-checked",
      "has *.test.ts sources but every tsconfig excludes them — those tests are never typechecked. Add a tsconfig.test.json that includes them (see packages/gateway/tsconfig.test.json)"
    );
  }
}

if (problems.length === 0) {
  console.log(`ok   ${workspaces().length} workspaces — tsconfigs consistent`);
  process.exit(0);
}

const byRule = new Map();
for (const p of problems) {
  if (!byRule.has(p.rule)) byRule.set(p.rule, []);
  byRule.get(p.rule).push(p);
}
for (const [rule, items] of byRule) {
  console.error(`\n${rule} (${items.length})`);
  for (const item of items) console.error(`  ${item.file}: ${item.message}`);
}
console.error(
  `\n${problems.length} tsconfig problem(s). See the rule notes at the top of scripts/lint-tsconfigs.mjs.`
);
process.exit(1);
