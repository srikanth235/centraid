#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");

const IMPORT_RE =
  /(?:from\s+|import\s*\(|require\s*\()\s*['"](?<spec>[^'"]+)['"]/gu;

const ENGINE_FORBIDDEN = [
  /@centraid\/server\/automation(?:\/|$)/u,
  /@centraid\/server\/acp(?:\/|$)/u,
  /@centraid\/automation(?:\/|$)/u,
  /@centraid\/agent-runtime(?:\/|$)/u,
  /(?:^|\/)src\/automation(?:\/|$)/u,
  /(?:^|\/)src\/acp(?:\/|$)/u,
  /(?:^|[./])\.\.\/automation(?:\/|$)/u,
  /(?:^|[./])\.\.\/acp(?:\/|$)/u,
];

const AUTOMATION_FORBIDDEN = [
  /@centraid\/server\/acp(?:\/|$)/u,
  /@centraid\/agent-runtime(?:\/|$)/u,
  /(?:^|\/)src\/acp(?:\/|$)/u,
  /(?:^|[./])\.\.\/acp(?:\/|$)/u,
];

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs"]);

export function normalizeSpecifier(fromDir, specifier) {
  if (specifier.startsWith(".")) {
    return path.posix.normalize(
      path.posix.join(fromDir.split(path.sep).join("/"), specifier)
    );
  }
  return specifier;
}

export function isForbiddenImport(tree, specifier) {
  const rules = tree === "engine" ? ENGINE_FORBIDDEN : AUTOMATION_FORBIDDEN;
  return rules.some((re) => re.test(specifier));
}

function walkTs(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkTs(full, acc);
      continue;
    }
    const ext = path.extname(entry.name);
    if (SOURCE_EXTS.has(ext) && !entry.name.endsWith(".d.ts")) acc.push(full);
  }
  return acc;
}

export function checkImportBoundary(opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT;
  const violations = [];

  function scan(tree, file, source) {
    const fromDir = path.dirname(file);
    for (const match of source.matchAll(IMPORT_RE)) {
      const raw = match.groups?.spec;
      if (!raw) continue;
      const normalized = normalizeSpecifier(fromDir, raw);
      if (isForbiddenImport(tree, raw) || isForbiddenImport(tree, normalized)) {
        violations.push(`${file}: ${tree} imports ${raw}`);
      }
    }
  }

  for (const tree of /** @type {const} */ (["engine", "automation"])) {
    const treeRoot = path.join(root, "src", tree);
    for (const file of walkTs(treeRoot)) {
      scan(tree, file, readFileSync(file, "utf8"));
    }
  }

  for (const extra of opts.extraFiles ?? []) {
    scan(extra.tree, extra.file, extra.source);
  }

  return { ok: violations.length === 0, violations };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const result = checkImportBoundary();
  if (!result.ok) {
    for (const line of result.violations) console.error(line);
    process.exit(1);
  }
  console.log("import-boundary: engine and automation seams hold");
}
