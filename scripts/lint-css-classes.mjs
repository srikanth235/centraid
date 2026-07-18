#!/usr/bin/env node
// CSS-module reference check — catches `className={styles.foo}` where the
// imported module has no `.foo` rule.
//
// Why this exists: it is the one class of frontend bug that EVERY existing gate
// passes. A missing CSS-module local is plain `undefined` at runtime, so:
//   - `typecheck` passes — CSS-module declarations type locals as a permissive
//     index signature, not a literal union of the rules that exist;
//   - `test` passes — vitest's `classNameStrategy: 'non-scoped'` makes
//     `styles.foo === 'foo'`, so a test selecting `.foo` still matches even
//     when no rule backs it;
//   - `build` passes — an unused/absent local is not an error.
// The element simply renders unstyled and nobody finds out. CSS-CONVENTIONS.md
// ("Verify before committing") asks for this to be eyeballed; eyeballs missed
// 10 of them, so it is automated here.
//
// Direction is deliberate: we check REFERENCED-but-undefined (always a bug),
// not DEFINED-but-unreferenced (legitimately noisy — descendant-only rules,
// `[data-*]` attribute hooks, and the `:global` contracts the conventions
// permit all look "unused" to a grep).
//
// Following scripts/lint-types.sh: a silent no-op FAILS rather than passing —
// if this ever scans zero files or resolves zero modules, the check is broken,
// not clean.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, basename } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
// Every *.module.css in the repo lives under here. If that changes, add the
// root — an unlisted directory is unchecked, exactly like lint-types.sh's
// TARGETS list.
const TARGETS = ['packages/client/src/react', 'packages/blueprints/apps'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = resolve(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Strip CSS comments so a class named only inside one isn't counted as defined. */
function definedClasses(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Leading [a-zA-Z] excludes `0.5px` / `11.5px` numerics; `-` and `_` are
  // legal in idents but cannot start one here (authored camelCase per
  // CSS-CONVENTIONS "Component modules").
  return new Set([...stripped.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

/**
 * Strip import lines and whole-line comments before scanning reads.
 * `import chrome from './chrome.module.css'` and a JSDoc line mentioning
 * `chrome.module.css` both otherwise self-match as a read of `chrome.module`.
 */
function scannableBody(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l) && !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

const findings = [];
const dynamic = [];
let filesScanned = 0;
let modulesResolved = 0;

for (const target of TARGETS) {
  const dir = resolve(ROOT, target);
  if (!existsSync(dir)) {
    console.error(`FAIL — target does not exist: ${target}`);
    process.exit(1);
  }
  for (const file of walk(dir)) {
    filesScanned += 1;
    const src = readFileSync(file, 'utf8');
    const imports = [...src.matchAll(/^import\s+(\w+)\s+from\s+'([^']+\.module\.css)'/gm)];
    if (imports.length === 0) continue;
    const body = scannableBody(src);
    const rel = relative(ROOT, file);

    for (const [, alias, spec] of imports) {
      const cssPath = resolve(dirname(file), spec);
      if (!existsSync(cssPath)) {
        findings.push(`${rel} — import '${spec}' does not resolve`);
        continue;
      }
      modulesResolved += 1;
      const defined = definedClasses(readFileSync(cssPath, 'utf8'));

      // Dynamic access defeats static analysis. Report it so the check can
      // never quietly become partial; there are zero today.
      if (new RegExp(`\\b${alias}\\[`).test(body)) {
        dynamic.push(`${rel} — ${alias}[…] computed access is unverifiable`);
      }

      for (const [, name] of body.matchAll(new RegExp(`\\b${alias}\\.([a-zA-Z][\\w]*)`, 'g'))) {
        if (!defined.has(name)) {
          findings.push(`${rel}:${alias}.${name} — no .${name} rule in ${basename(cssPath)}`);
        }
      }
    }
  }
}

// Silent-no-op guard (see header): a pass that checked nothing is a failure.
if (filesScanned === 0 || modulesResolved === 0) {
  console.error(
    `FAIL — scanned ${filesScanned} file(s), resolved ${modulesResolved} CSS module(s). ` +
      `The check matched nothing; its import pattern or TARGETS are stale.`,
  );
  process.exit(1);
}

for (const d of [...new Set(dynamic)].sort()) console.warn(`warn  ${d}`);

if (findings.length > 0) {
  console.error(`\nFAIL — ${findings.length} className(s) with no backing CSS rule:\n`);
  for (const f of [...new Set(findings)].sort()) console.error(`  ${f}`);
  console.error(
    `\nEach renders as class="" at runtime. Either write the rule, or drop the\n` +
      `reference if the intended layout already comes from elsewhere.\n`,
  );
  process.exit(1);
}

console.log(
  `ok   css-classes — ${modulesResolved} module import(s) across ${filesScanned} file(s), no dead classNames`,
);
