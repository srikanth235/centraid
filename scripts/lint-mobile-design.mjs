#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_ROOT = path.join(ROOT, "apps", "mobile");
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".expo",
  "test",
  "tests",
]);
const LOWERING_OWNER_SUFFIXES = [
  path.join("kit", "theme", "native.ts"),
  path.join("kit", "theme", "resolve.ts"),
];

function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (match) => " ".repeat(match.length));
}

const FORBIDDEN = [
  ["Feather dependency", /(?:Feather|@expo\/vector-icons)/u],
  ["CSS custom-property consumption", /var\(\s*--/u],
  ["CSS parser", /(?:CSSStyleDeclaration|evalColorMix|parseCss|parseCSS)/u],
  [
    "retired token spelling",
    /--(?:bg-pressed|accent-fill-hover|dur-fast|dur-normal|brand|bezel)\b/u,
  ],
];

const CONSUMER_LITERAL_RULES = [
  ["numeric fontSize; use t(<role>)", /\bfontSize\s*:\s*-?\d+(?:\.\d+)?\b/gu],
  [
    "numeric lineHeight; use t(<role>)",
    /\blineHeight\s*:\s*-?\d+(?:\.\d+)?\b/gu,
  ],
  [
    "literal fontWeight; use t(<role>)",
    /\bfontWeight\s*:\s*(?:["']\d{3}["']|\d{3})(?!\d)/gu,
  ],
  [
    "literal fontFamily; use t(<role>) or family.<code role>",
    /\bfontFamily\s*:\s*["'][^"']+["']/gu,
  ],
  [
    "numeric radius; use radii.<role>",
    /\b(?:borderRadius|borderTopLeftRadius|borderTopRightRadius|borderBottomLeftRadius|borderBottomRightRadius|borderStartStartRadius|borderStartEndRadius|borderEndStartRadius|borderEndEndRadius)\s*:\s*-?\d+(?:\.\d+)?\b/gu,
  ],
  [
    "literal style color; use colors.<role>",
    /\b(?:color|backgroundColor|borderColor|borderBottomColor|borderTopColor|borderLeftColor|borderRightColor|borderStartColor|borderEndColor|shadowColor|textDecorationColor|tintColor)\s*:\s*["'](?:#[0-9a-f]{3,8}\b|rgba?\()/giu,
  ],
  [
    "literal JSX color; use colors.<role>",
    /\bcolor\s*=\s*["'](?:#[0-9a-f]{3,8}\b|rgba?\()/giu,
  ],
];

function lineFor(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

export function analyzeNativeConsumer(source) {
  const code = blankComments(source);
  const findings = [];
  for (const [label, pattern] of [...FORBIDDEN, ...CONSUMER_LITERAL_RULES]) {
    const match = pattern.exec(code);
    pattern.lastIndex = 0;
    if (match) findings.push(`${lineFor(code, match.index)}: ${label}`);
  }
  return findings;
}

function walk(directory, out = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) walk(absolute, out);
    else if (
      /\.(?:ts|tsx)$/u.test(entry) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/u.test(entry) &&
      !LOWERING_OWNER_SUFFIXES.some((suffix) => absolute.endsWith(suffix))
    ) {
      out.push(absolute);
    }
  }
  return out;
}

export function scanMobileDesign(root = ROOT) {
  const sourceRoot = path.join(root, "apps", "mobile", "src");
  const files = [
    path.join(root, "apps", "mobile", "App.tsx"),
    ...walk(sourceRoot),
  ];
  const findings = [];

  for (const file of new Set(files)) {
    for (const finding of analyzeNativeConsumer(readFileSync(file, "utf8"))) {
      findings.push(`${path.relative(root, file)}:${finding}`);
    }
  }

  return findings;
}

function main() {
  if (!existsSync(MOBILE_ROOT)) throw new Error("apps/mobile is missing");
  const findings = scanMobileDesign();
  if (findings.length > 0) {
    console.error("FAIL — native consumer-design gate:");
    for (const finding of findings) console.error(`  ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "ok   native consumer design — typed lowering, zero literal debt"
  );
}

if (process.argv[1] === import.meta.filename) main();
