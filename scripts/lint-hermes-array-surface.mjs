#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

const ENTRY_DIRS = ["apps/mobile/src"];

const MISSING = new Map([
  ["toSorted", "sort a fresh array with .sort() instead"],
]);

const SOURCE_RE = /\.tsx?$/u;
const TEST_RE = /\.(?:test|test-fixtures|spec)\.tsx?$|\/__tests__\//u;

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
        // Intentionally empty.
      }
    }
  }
  return map;
}

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
