#!/usr/bin/env node
// Mobile product-grammar gate (#690).
//
// Native consumes the typed lowering, never CSS. This gate keeps the mobile
// source and checked-in generated module from regressing to the old token
// vocabulary, a CSS parser, or the retired Feather dependency.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_ROOT = path.join(ROOT, "apps", "mobile");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".expo"]);

// Ratchet the migration surface. These are the post-grammar counts in the
// v0 baseline; lowering a bespoke value is welcome, adding one requires an
// explicit review of the shared token contract instead of silently expanding
// the exception surface.
export const MOBILE_DESIGN_BASELINE = Object.freeze({
  hex: 302,
  rgba: 62,
  fontSize: 315,
});

const FORBIDDEN = [
  ["Feather dependency", /(?:Feather|@expo\/vector-icons)/u],
  ["CSS custom-property consumption", /var\(\s*--/u],
  ["CSS parser", /(?:CSSStyleDeclaration|evalColorMix|parseCss|parseCSS)/u],
  [
    "retired token spelling",
    /--(?:bg-pressed|accent-fill-hover|dur-fast|dur-normal|brand|bezel)\b/u,
  ],
];

function walk(directory, out = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) walk(absolute, out);
    else if (/\.(?:ts|tsx)$/u.test(absolute)) out.push(absolute);
  }
  return out;
}

export function scanMobileDesign(root = ROOT) {
  const sourceRoot = path.join(root, "apps", "mobile", "src");
  const generated = path.join(
    sourceRoot,
    "kit",
    "theme",
    "tokens.generated.ts"
  );
  const files = [
    path.join(root, "apps", "mobile", "App.tsx"),
    ...walk(sourceRoot),
  ];
  const uniqueFiles = [...new Set(files)];
  const findings = [];

  const counts = { fontSize: 0, hex: 0, rgba: 0 };
  const literalPatterns = {
    fontSize: /fontSize\s*:/gu,
    hex: /#[0-9a-f]{3,8}\b/giu,
    rgba: /rgba\(/gu,
  };

  for (const file of uniqueFiles) {
    const source = readFileSync(file, "utf8");
    for (const [label, pattern] of FORBIDDEN) {
      if (pattern.test(source))
        findings.push(`${path.relative(root, file)}: ${label}`);
    }
    for (const [name, pattern] of Object.entries(literalPatterns)) {
      counts[name] += (source.match(pattern) ?? []).length;
    }
  }

  for (const [name, baseline] of Object.entries(MOBILE_DESIGN_BASELINE)) {
    if (counts[name] > baseline) {
      findings.push(
        `apps/mobile: ${name} literal count ${counts[name]} exceeds baseline ${baseline}`
      );
    }
  }

  const generatedSource = readFileSync(generated, "utf8");
  for (const [label, pattern] of FORBIDDEN) {
    if (pattern.test(generatedSource))
      findings.push(`${path.relative(root, generated)}: ${label}`);
  }

  for (const required of [
    "accentDeepHover",
    "appIdentityText",
    "bgSel",
    "lineSel",
    "focusRingColor",
    "textDisabled",
    'export const durations = {"one":140,"two":280}',
  ]) {
    if (!generatedSource.includes(required))
      findings.push(`${path.relative(root, generated)}: missing ${required}`);
  }
  return findings;
}

function main() {
  if (!existsSync(MOBILE_ROOT)) throw new Error("apps/mobile is missing");
  const findings = scanMobileDesign();
  if (findings.length > 0) {
    console.error("FAIL — mobile product-grammar gate:");
    for (const finding of findings) console.error(`  ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log("ok   mobile product-grammar — typed native lowering is clean");
}

if (process.argv[1] === import.meta.filename) main();
