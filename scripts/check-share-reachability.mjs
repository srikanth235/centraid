#!/usr/bin/env node
/**
 * Sharing-plane export reachability check (issue #750).
 *
 * Knip's dead-export detection stops at workspace entry files: anything
 * re-exported through `src/index.ts` counts as "used" because the barrel is an
 * entry, and colocated vitest files are entries too. That combination launders
 * dead sharing-plane capabilities — `declareCommonsCommands` was exported,
 * re-exported by the vault barrel, and called by nothing in production, yet
 * every existing gate stayed green.
 *
 * This check closes that class. For every value export of the configured
 * sharing-plane modules (`share-reachability.json` at the repo root) it
 * resolves the transitive importer set, following re-exports through index.ts
 * barrels and workspace package specifiers, and fails unless at least one
 * production file (non-test source under packages/ or apps/, per the
 * TESTING.md naming conventions) imports the capability in a value position.
 * Test files, type-only imports/usages, and pure re-export sites do not count
 * as reachers. A value-position use inside the capability's own declaring
 * production module does count (see the same-file rule in
 * `runShareReachability`). Documented exceptions live in the config's `allowlist`, one
 * reason string per entry (knip.json's documented-exception style); stale
 * entries fail so the list can only shrink.
 *
 * The per-file syntax scan lives in `share-reachability-parse.mjs`; it uses the
 * repo-pinned `typescript` package for syntax-level parsing only (no type
 * checking, no new dependencies).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parseModule } from "./share-reachability-parse.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const CONFIG_FILE = "share-reachability.json";

const SOURCE_ROOTS = ["packages", "apps", "tools"];
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
const SOURCE_RE = /\.(?:ts|tsx|mts)$/u;

/**
 * Test/benchmark/fixture classification by path convention, aligned with the
 * TESTING.md taxonomy (`*.test.ts[x]`, `*.integration.test.ts`,
 * `*.contract.test.ts`, `*.spec.ts`, perf/scale suites, `tests/` trees,
 * benchmarks, test kits, and fixture modules). Exported for the analyzer
 * tests.
 */
export function isTestPath(relPath) {
  const p = relPath.replaceAll("\\", "/");
  if (/(?:^|\/)(?:tests?|e2e|benchmarks?|__fixtures__|fixtures)\//u.test(p)) {
    return true;
  }
  if (p.startsWith("packages/test-kit/")) return true;
  const base = p.slice(p.lastIndexOf("/") + 1);
  return (
    base.includes(".test.") ||
    base.includes(".spec.") ||
    /\.test-fixtures\.tsx?$/u.test(base) ||
    /-test-kit\.tsx?$/u.test(base) ||
    /-fixtures?\.tsx?$/u.test(base)
  );
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
  const withPlaceholders = escaped
    .replaceAll("**/", "\u0000")
    .replaceAll("**", "\u0001")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", "(?:[^/]+/)*")
    .replaceAll("\u0001", ".*");
  return new RegExp(`^${withPlaceholders}$`, "u");
}

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
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (SOURCE_RE.test(name)) files.push(full);
    }
  };
  for (const sub of SOURCE_ROOTS) walk(path.join(root, sub));
  return files;
}

/** Map workspace package name → absolute package dir, from package.json files. */
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
      const pkgJson = path.join(base, name, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
        if (typeof pkg.name === "string") {
          map.set(pkg.name, path.join(base, name));
        }
      } catch {
        // not a package dir
      }
    }
  }
  return map;
}

/** The full repo analysis. `root` is injectable so the fail paths are testable. */
export function runShareReachability(root, config) {
  const moduleRes = (config.modules ?? []).map((g) => globToRegExp(g));
  const workspaceByName = buildWorkspaceMap(root);

  const files = new Map(); // absolute path → parsed module info
  const relOf = (abs) => path.relative(root, abs).replaceAll("\\", "/");
  for (const abs of listSourceFiles(root)) {
    files.set(abs, parseModule(abs, readFileSync(abs, "utf8")));
  }

  const tryFile = (abs) => {
    const candidates = [abs];
    if (abs.endsWith(".js")) {
      const stem = abs.slice(0, -".js".length);
      candidates.push(`${stem}.ts`, `${stem}.tsx`);
    } else if (!SOURCE_RE.test(abs)) {
      candidates.push(`${abs}.ts`, `${abs}.tsx`, path.join(abs, "index.ts"));
    }
    for (const c of candidates) if (files.has(c)) return c;
    return null;
  };

  const resolveSpec = (fromAbs, spec) => {
    if (spec.startsWith(".")) {
      return tryFile(path.resolve(path.dirname(fromAbs), spec));
    }
    for (const [name, dir] of workspaceByName) {
      if (spec === name) {
        return (
          tryFile(path.join(dir, "src", "index.ts")) ??
          tryFile(path.join(dir, "index.ts"))
        );
      }
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

  // exported name set per module (needed to expand `export *`), cycle-safe
  const exportedNamesMemo = new Map();
  const exportedNamesOf = (abs, seen = new Set()) => {
    if (exportedNamesMemo.has(abs)) return exportedNamesMemo.get(abs);
    if (seen.has(abs)) return new Set();
    seen.add(abs);
    const info = files.get(abs);
    const names = new Set();
    if (info) {
      for (const n of info.localExports.keys()) names.add(n);
      for (const e of info.exportList) names.add(e.exported);
      for (const re of info.reexports) {
        if (re.star) {
          const target = resolveSpec(abs, re.spec);
          // `export * from` deliberately does NOT carry `default` (ES2015
          // §15.2.3), so a barrel over a default-exporting module must not
          // make that component look re-exported.
          if (target)
            for (const n of exportedNamesOf(target, seen))
              if (n !== "default") names.add(n);
        } else {
          for (const n of re.names) names.add(n.exported);
        }
      }
    }
    exportedNamesMemo.set(abs, names);
    return names;
  };

  // origin of (module, exported name): the file that declares the capability
  const originMemo = new Map();
  const exportOrigin = (abs, name, seen = new Set()) => {
    const key = `${abs}\0${name}`;
    if (originMemo.has(key)) return originMemo.get(key);
    if (seen.has(key)) return null;
    seen.add(key);
    const info = files.get(abs);
    let origin = null;
    if (!info) {
      origin = { file: abs, name, typeOnly: false };
    } else if (info.localExports.has(name)) {
      origin = {
        file: abs,
        name,
        typeOnly: info.localExports.get(name) === "type",
      };
    } else {
      const listed = info.exportList.find((e) => e.exported === name);
      if (listed) {
        // `export { a as b }`: if `a` is imported, follow the chain; else local.
        let followed = null;
        for (const imp of info.imports) {
          const bound = imp.names.find((n) => n.local === listed.local);
          if (bound) {
            const target = resolveSpec(abs, imp.spec);
            if (target) {
              followed = exportOrigin(target, bound.imported, seen);
              if (followed && (bound.typeOnly || listed.typeOnly)) {
                followed = { ...followed, typeOnly: true };
              }
            }
            break;
          }
        }
        origin = followed ?? {
          file: abs,
          name,
          typeOnly:
            listed.typeOnly || info.declKinds.get(listed.local) === "type",
        };
      } else {
        for (const re of info.reexports) {
          const named = re.star
            ? null
            : re.names.find((n) => n.exported === name);
          if (!re.star && !named) continue;
          const target = resolveSpec(abs, re.spec);
          if (!target) continue;
          if (re.star && !exportedNamesOf(target).has(name)) continue;
          const inner = exportOrigin(
            target,
            named ? named.imported : name,
            seen
          );
          if (inner) {
            origin =
              re.typeOnly || named?.typeOnly === true
                ? { ...inner, typeOnly: true }
                : inner;
            break;
          }
        }
      }
    }
    originMemo.set(key, origin);
    return origin;
  };

  // Scoped capability targets: value exports declared by the configured
  // modules. Each target remembers its declaring file and the *local* name it
  // is declared under (which differs from the exported name for
  // `export { local as exported }`), because the same-file rule below has to
  // look the local name up in the declaring module's own usage map.
  const targets = new Map(); // "rel#name" → { file, local, reachers }
  for (const [abs, info] of files) {
    const rel = relOf(abs);
    if (!moduleRes.some((re) => re.test(rel))) continue;
    if (isTestPath(rel)) continue;
    for (const [name, kind] of info.localExports) {
      if (kind !== "value") continue;
      // `default` is not an identifier: the same-file rule has to look the
      // declaration up under the name it was declared with, when it has one.
      const local = name === "default" ? info.defaultLocal : name;
      targets.set(`${rel}#${name}`, newTarget(abs, local ?? name));
    }
    for (const e of info.exportList) {
      // Only names that originate here (not import-then-re-export laundering).
      const origin = exportOrigin(abs, e.exported);
      if (origin && origin.file === abs && !origin.typeOnly) {
        targets.set(`${rel}#${e.exported}`, newTarget(abs, e.local));
      }
    }
  }

  const targetKeyOf = (origin) => {
    if (!origin || origin.typeOnly) return null;
    const key = `${relOf(origin.file)}#${origin.name}`;
    return targets.has(key) ? key : null;
  };

  // Reach classification per importing file.
  for (const [abs, info] of files) {
    const rel = relOf(abs);
    const isTest = isTestPath(rel);
    const isProductionTree =
      rel.startsWith("packages/") || rel.startsWith("apps/");

    const record = (key, bucket) => {
      const t = targets.get(key);
      if (!t.reachers[bucket].includes(rel)) t.reachers[bucket].push(rel);
    };
    const classify = (key, typeOnlyReach, originFile) => {
      if (originFile === abs) return; // the defining module is not its own caller
      if (isTest || !isProductionTree) record(key, "test");
      else if (typeOnlyReach) record(key, "typeOnly");
      else record(key, "production");
    };

    for (const imp of info.imports) {
      const target = resolveSpec(abs, imp.spec);
      if (!target) continue;
      for (const bound of imp.names) {
        const origin = exportOrigin(target, bound.imported);
        const key = targetKeyOf(origin);
        if (!key) continue;
        const valueUses = info.valueUse.get(bound.local) ?? 0;
        const typeUses = info.typeUse.get(bound.local) ?? 0;
        if (bound.typeOnly || (valueUses === 0 && typeUses > 0)) {
          classify(key, true, origin.file);
        } else if (valueUses > 0) {
          classify(key, false, origin.file);
        }
        // imported but never used in any position: a pure re-export site (the
        // chain is followed via exportOrigin) or dead import — not a reach.
      }
    }
    for (const ns of info.namespaceImports) {
      const target = resolveSpec(abs, ns.spec);
      if (!target) continue;
      for (const name of exportedNamesOf(target)) {
        const origin = exportOrigin(target, name);
        const key = targetKeyOf(origin);
        if (!key) continue;
        const valueUses = info.nsValueUse.get(ns.local)?.get(name) ?? 0;
        const typeUses = info.nsTypeUse.get(ns.local)?.get(name) ?? 0;
        if (valueUses > 0 && !ns.typeOnly) classify(key, false, origin.file);
        else if (typeUses > 0 || (valueUses > 0 && ns.typeOnly)) {
          classify(key, true, origin.file);
        }
      }
    }
    for (const spec of info.dynamicImportSpecs) {
      const target = resolveSpec(abs, spec);
      if (!target) continue;
      // Conservative: a dynamic import reaches every export of its target.
      for (const name of exportedNamesOf(target)) {
        const origin = exportOrigin(target, name);
        const key = targetKeyOf(origin);
        if (key) classify(key, false, origin.file);
      }
    }
  }

  // Same-file rule: a capability used in a value position inside its own
  // declaring module, where that module is production code, is reached in
  // production — the surrounding module runs, so the use runs. This mirrors
  // knip's `ignoreExportsUsedInFile` convention (already adopted repo-wide)
  // and composes with it: knip fails on unused *files*, so a module that
  // reaches only itself is either alive (its own callers run this code) or
  // knip deletes the whole file. What this gate still catches is the defect
  // class it exists for — a capability like `declareCommonsCommands` or
  // `pushRouteAssertion` that lives in a live module but is invoked nowhere,
  // in-file or out. Exports whose only in-file appearance is their own
  // declaration (see `declaredNameNodes` in `parseModule`) or a type position
  // do not qualify.
  for (const t of targets.values()) {
    if (t.reachers.production.length > 0) continue;
    const rel = relOf(t.file);
    if (isTestPath(rel)) continue;
    if ((files.get(t.file)?.valueUse.get(t.local) ?? 0) > 0) {
      t.reachers.production.push(`${rel} (same-file)`);
    }
  }

  // Verdicts + allowlist reconciliation.
  const allowlist = config.allowlist ?? [];
  const allowlisted = new Map(allowlist.map((e) => [e.capability, e]));
  const offenses = [];
  const configErrors = [];
  for (const entry of allowlist) {
    if (
      typeof entry.capability !== "string" ||
      !entry.capability.includes("#")
    ) {
      configErrors.push(
        `allowlist entry ${JSON.stringify(entry.capability)} must be "<path>#<export>"`
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      configErrors.push(
        `allowlist entry ${entry.capability} needs a non-empty reason`
      );
    }
  }

  const failing = new Set();
  for (const [key, t] of targets) {
    if (t.reachers.production.length > 0) continue;
    failing.add(key);
    if (allowlisted.has(key)) continue;
    const why = [];
    if (t.reachers.test.length > 0) {
      why.push(`test-only reachers: ${t.reachers.test.sort().join(", ")}`);
    }
    if (t.reachers.typeOnly.length > 0) {
      why.push(`type-only reachers: ${t.reachers.typeOnly.sort().join(", ")}`);
    }
    if (why.length === 0)
      why.push("no reachers at all (barrel re-export only, or dead)");
    offenses.push({ capability: key, why: why.join("; ") });
  }
  const staleAllowlist = allowlist
    .map((e) => e.capability)
    .filter((cap) => typeof cap === "string" && !failing.has(cap));

  offenses.sort((a, b) => a.capability.localeCompare(b.capability));
  return {
    scopedModules: moduleRes.length,
    targetCount: targets.size,
    offenses,
    staleAllowlist,
    configErrors,
  };
}

function newTarget(file, local) {
  return { file, local, reachers: { production: [], typeOnly: [], test: [] } };
}

function main() {
  const config = JSON.parse(
    readFileSync(path.join(repoRoot, CONFIG_FILE), "utf8")
  );
  const result = runShareReachability(repoRoot, config);
  const problems = [];
  for (const err of result.configErrors) {
    problems.push(`${CONFIG_FILE}: ${err}`);
  }
  for (const offense of result.offenses) {
    problems.push(
      `${offense.capability}: no production caller (${offense.why}) — ` +
        `remove the capability (and its barrel re-export) or add a documented ${CONFIG_FILE} allowlist entry`
    );
  }
  for (const cap of result.staleAllowlist) {
    problems.push(
      `${CONFIG_FILE}: stale allowlist entry ${cap} — the capability now has a production caller (or no longer exists); delete the entry`
    );
  }
  if (problems.length > 0) {
    process.stderr.write(
      `sharing-plane reachability (#750):\n${problems.map((p) => `  ${p}`).join("\n")}\n`
    );
    process.exit(1);
  }
  const allowCount = (config.allowlist ?? []).length;
  process.stdout.write(
    `share reachability: ok (${result.targetCount} capabilities across ${result.scopedModules} module globs` +
      `${allowCount > 0 ? `, ${allowCount} allowlisted TODO(#750)` : ""})\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
