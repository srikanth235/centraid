#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGETS = ["packages/client/src/react", "packages/blueprints/apps"];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = path.resolve(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/u.test(p)) out.push(p);
  }
  return out;
}

function definedClasses(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const matches = [...stripped.matchAll(/\.(?<className>[a-zA-Z][\w-]*)/gu)];
  return new Set(matches.map((m) => m.groups?.className ?? ""));
}

function scannableBody(src) {
  return src
    .split("\n")
    .filter((l) => !/^\s*import\s/u.test(l) && !/^\s*(?:\/\/|\/\*|\*)/u.test(l))
    .join("\n");
}

export function lintCssClasses(root = ROOT, targets = TARGETS) {
  const findings = [];
  const dynamic = [];
  let filesScanned = 0;
  let modulesResolved = 0;

  for (const target of targets) {
    const dir = path.resolve(root, target);
    if (!existsSync(dir)) {
      return {
        findings,
        dynamic,
        filesScanned,
        modulesResolved,
        missingTarget: target,
      };
    }
    for (const file of walk(dir)) {
      filesScanned += 1;
      const src = readFileSync(file, "utf8");
      const imports = [
        ...src.matchAll(
          /^import\s+(?<alias>\w+)\s+from\s+['"](?<spec>[^'"]+\.module\.css)['"]/gmu
        ),
      ];
      if (imports.length === 0) continue;
      const body = scannableBody(src);
      const rel = path.relative(root, file);

      for (const imported of imports) {
        const alias = imported.groups?.alias ?? "";
        const spec = imported.groups?.spec ?? "";
        const cssPath = path.resolve(path.dirname(file), spec);
        if (!existsSync(cssPath)) {
          findings.push(`${rel} — import '${spec}' does not resolve`);
          continue;
        }
        modulesResolved += 1;
        const defined = definedClasses(readFileSync(cssPath, "utf8"));

        if (new RegExp(`\\b${alias}\\[`, "u").test(body)) {
          dynamic.push(`${rel} — ${alias}[…] computed access is unverifiable`);
        }

        for (const [, name] of body.matchAll(
          new RegExp(`\\b${alias}\\.([a-zA-Z][\\w]*)`, "gu")
        )) {
          if (!defined.has(name)) {
            findings.push(
              `${rel}:${alias}.${name} — no .${name} rule in ${path.basename(cssPath)}`
            );
          }
        }
      }
    }
  }
  return {
    findings,
    dynamic,
    filesScanned,
    modulesResolved,
    missingTarget: null,
  };
}

function main() {
  const { findings, dynamic, filesScanned, modulesResolved, missingTarget } =
    lintCssClasses();

  if (missingTarget) {
    console.error(`FAIL — target does not exist: ${missingTarget}`);
    process.exit(1);
  }

  if (filesScanned === 0 || modulesResolved === 0) {
    console.error(
      `FAIL — scanned ${filesScanned} file(s), resolved ${modulesResolved} CSS module(s). ` +
        `The check matched nothing; its import pattern or TARGETS are stale.`
    );
    process.exit(1);
  }

  for (const d of [...new Set(dynamic)].sort()) console.warn(`warn  ${d}`);

  if (findings.length > 0) {
    console.error(
      `\nFAIL — ${findings.length} className(s) with no backing CSS rule:\n`
    );
    for (const f of [...new Set(findings)].sort()) console.error(`  ${f}`);
    console.error(
      `\nEach renders as class="" at runtime. Either write the rule, or drop the\n` +
        `reference if the intended layout already comes from elsewhere.\n`
    );
    process.exit(1);
  }

  console.log(
    `ok   css-classes — ${modulesResolved} module import(s) across ${filesScanned} file(s), no dead classNames`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
