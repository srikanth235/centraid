#!/usr/bin/env node

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
        // Intentionally empty.
      }
    }
  }
  return map;
}

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

  const targets = new Map(); // "rel#name" → { file, local, reachers }
  for (const [abs, info] of files) {
    const rel = relOf(abs);
    if (!moduleRes.some((re) => re.test(rel))) continue;
    if (isTestPath(rel)) continue;
    for (const [name, kind] of info.localExports) {
      if (kind !== "value") continue;
      const local = name === "default" ? info.defaultLocal : name;
      targets.set(`${rel}#${name}`, newTarget(abs, local ?? name));
    }
    for (const e of info.exportList) {
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
      for (const name of exportedNamesOf(target)) {
        const origin = exportOrigin(target, name);
        const key = targetKeyOf(origin);
        if (key) classify(key, false, origin.file);
      }
    }
  }

  for (const t of targets.values()) {
    if (t.reachers.production.length > 0) continue;
    const rel = relOf(t.file);
    if (isTestPath(rel)) continue;
    if ((files.get(t.file)?.valueUse.get(t.local) ?? 0) > 0) {
      t.reachers.production.push(`${rel} (same-file)`);
    }
  }

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
