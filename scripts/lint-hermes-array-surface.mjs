#!/usr/bin/env node
/**
 * The ES2023 Array surface Hermes does not implement, checked against what the
 * PHONE ACTUALLY BUNDLES rather than against a hand-written glob (#905).
 *
 * `oxlint.config.ts` has banned `toSorted` since the native Photos cover
 * redboxed on it, and the ban was never wrong — its `files` glob was
 * `apps/mobile/src/**` plus `packages/core/src/time/**`, and the eight sites
 * that took the Docs cover down on a device were all in `packages/blueprints`.
 * A glob cannot express "everything the mobile bundle reaches", so the glob was
 * a guess about reachability, and the guess is what failed. This walks the
 * import graph instead: the answer is derived, so it cannot drift.
 *
 * Node's Array prototype has every one of these, which is why thousands of unit
 * tests pass over code that cannot render on a phone. Only a device or this
 * gate can see it.
 *
 * What is measured and what is assumed is spelt out on `MISSING` below; the
 * name of this file overstates it, and the map is the honest version.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Where a bundled module can live. Nothing under `tests/` or `scripts/` is
 *  reachable from Metro, so the walk never needs to enter them. */
const SOURCE_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "artifacts",
  ".turbo",
  ".expo",
  ".next",
]);

/** Where the bundle starts. Every phone-reachable module is downstream of one
 *  of these; nothing else in the repo is entered by Metro. */
const ENTRY_DIRS = ["apps/mobile/src"];

/**
 * Array methods absent from the reviewed Hermes runtime (Expo 57 / RN 0.86).
 *
 * ONE name, because one is what the evidence supports (#905). `toSorted` is
 * the method the device actually threw on — `AllShelf`'s own frame,
 * `[...labels].toSorted(...)`, `undefined is not a function` on the phone —
 * and #903's `apps/mobile/polyfills/array-to-sorted.js` reaches the same
 * finding from the engine side: it names the build (Static Hermes
 * 250829098.0.16) and the upstream PR still open for this one method, and
 * records that the engine DOES ship `toReversed`, `toSpliced`, `with` and
 * `findLast`.
 *
 * Those four were briefly banned here too. That was a generalization from the
 * single `toSorted` throw by family resemblance — "Hermes ships no ES2023
 * change-array-by-copy" — and nothing ever measured it. A gate that fails a
 * build over a method the engine implements is not a cautious gate, it is a
 * wrong one, and it makes every other name on this list less believable. So
 * the list is what is known.
 *
 * `with` is out for a second, independent reason: `.with(` is a common builder
 * verb, and a property-name check cannot tell `array.with(0, x)` from a fluent
 * API's own `with`. Reaching that one needs a type checker, which this is not.
 */
const MISSING = new Map([
  ["toSorted", "sort a fresh array with .sort() instead"],
]);

const SOURCE_RE = /\.tsx?$/u;
/** Tests never reach a device; they run in Node, where these all exist. */
const TEST_RE = /\.(?:test|test-fixtures|spec)\.tsx?$|\/__tests__\//u;

/** Relative to the root under analysis — `root` is injectable so the walk can
 *  be exercised over a fixture repo, which is the only way to test the
 *  reachability rule itself rather than today's tree. */
const relTo = (root, abs) => path.relative(root, abs).replaceAll("\\", "/");

function listSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_RE.test(name)) files.push(full);
    }
  };
  for (const sub of SOURCE_ROOTS) walk(path.join(root, sub));
  return files;
}

/** Workspace package name → directory, from each workspace's own package.json. */
function buildWorkspaceMap(root) {
  const map = new Map();
  for (const sub of SOURCE_ROOTS) {
    const base = path.join(root, sub);
    let names;
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const manifest = path.join(base, name, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof pkg.name === "string")
          map.set(pkg.name, path.join(base, name));
      } catch {
        // not a package manifest we can read; nothing to map
      }
    }
  }
  return map;
}

/**
 * One module's outgoing VALUE import specifiers plus every banned property it
 * names. Type-only imports are skipped: they are erased before Metro sees them,
 * so a module reached only for its types ships no code and cannot throw.
 */
function scanModule(abs, text) {
  const source = ts.createSourceFile(
    abs,
    text,
    ts.ScriptTarget.ES2022,
    true,
    abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const specs = [];
  const hits = [];

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const clause = ts.isImportDeclaration(node)
        ? node.importClause
        : undefined;
      const typeOnly = ts.isImportDeclaration(node)
        ? clause?.isTypeOnly === true
        : node.isTypeOnly;
      const spec = ts.isImportDeclaration(node)
        ? node.moduleSpecifier
        : node.moduleSpecifier;
      if (!typeOnly && spec && ts.isStringLiteral(spec)) specs.push(spec.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }

    // The AST, never a regex: a banned name inside a comment or a string is
    // not a call, and this gate must not cry wolf on prose that discusses it —
    // this file's own header names all five.
    if (
      ts.isPropertyAccessExpression(node) &&
      MISSING.has(node.name.text) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node
    ) {
      const { line } = source.getLineAndCharacterOfPosition(
        node.name.getStart(source)
      );
      hits.push({ property: node.name.text, line: line + 1 });
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return { specs, hits };
}

export function runHermesArraySurface(root = ROOT) {
  const workspaceByName = buildWorkspaceMap(root);
  const sources = new Set(
    listSourceFiles(root).filter((abs) => !TEST_RE.test(abs))
  );

  const tryFile = (abs) => {
    const candidates = [abs];
    if (abs.endsWith(".js")) {
      const stem = abs.slice(0, -".js".length);
      candidates.push(`${stem}.ts`, `${stem}.tsx`);
    } else if (!SOURCE_RE.test(abs)) {
      candidates.push(
        `${abs}.ts`,
        `${abs}.tsx`,
        path.join(abs, "index.ts"),
        path.join(abs, "index.tsx")
      );
    }
    for (const c of candidates) if (sources.has(c)) return c;
    return null;
  };

  const resolveSpec = (fromAbs, spec) => {
    if (spec.startsWith("."))
      return tryFile(path.resolve(path.dirname(fromAbs), spec));
    for (const [name, dir] of workspaceByName) {
      if (spec === name)
        return (
          tryFile(path.join(dir, "src", "index.ts")) ??
          tryFile(path.join(dir, "index.ts"))
        );
      if (spec.startsWith(`${name}/`)) {
        const rest = spec.slice(name.length + 1);
        return (
          tryFile(path.join(dir, "src", rest)) ??
          tryFile(path.join(dir, rest)) ??
          (rest.startsWith("dist/")
            ? tryFile(path.join(dir, "src", rest.slice("dist/".length)))
            : null)
        );
      }
    }
    // A bare specifier that is not a workspace package is a node_module. Metro
    // bundles those too, but they are not ours to rewrite and a vendored
    // polyfill is the answer there, not a lint.
    return null;
  };

  const queue = [...sources].filter((abs) =>
    ENTRY_DIRS.some((dir) => relTo(root, abs).startsWith(`${dir}/`))
  );
  const reached = new Set(queue);
  const scanned = new Map();

  while (queue.length > 0) {
    const abs = queue.pop();
    const info = scanModule(abs, readFileSync(abs, "utf8"));
    scanned.set(abs, info);
    for (const spec of info.specs) {
      const target = resolveSpec(abs, spec);
      if (target && !reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }

  const violations = [];
  for (const [abs, info] of scanned) {
    for (const hit of info.hits) {
      violations.push({
        file: relTo(root, abs),
        line: hit.line,
        property: hit.property,
        remedy: MISSING.get(hit.property),
      });
    }
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { reached: reached.size, violations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { reached, violations } = runHermesArraySurface();
  if (violations.length > 0) {
    console.error(
      `The mobile bundle reaches ${reached} modules; ${violations.length} call an Array method Hermes does not implement:\n`
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  .${v.property}() — ${v.remedy}`);
    }
    console.error(
      "\nNode has all of these, so unit tests cannot see this. On a phone the property is undefined and the call throws, taking the whole route down."
    );
    process.exit(1);
  }
  console.log(
    `ok — ${reached} modules reachable from the mobile bundle, none calling an Array method Hermes lacks`
  );
}
