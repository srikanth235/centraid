import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".app-boot",
]);

const ROOT = path.resolve(import.meta.dirname, "..");
const TS_EXTENSION = /\.tsx?$/u;
const PRESS_CONTEXT_RE = /press|hover/iu;
const TS_OPACITY_DECL_RE = /(?<![\w-])opacity\s*:\s*(?<value>[^,;}]+)[,;}]/gu;

export const TS_BUDGETS = {
  "apps/mobile/src": 0,
};

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

function numericValue(raw: string): number | null {
  const cleaned = raw.replace(/!important/u, "").trim();
  if (!/^[0-9.]+$/u.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function blankJsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, (m: string) => m.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (m: string) => " ".repeat(m.length));
}

function walkExt(dir: string, extension: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = path.resolve(dir, entry);
    if (statSync(p).isDirectory()) walkExt(p, extension, out);
    else if (extension.test(p)) out.push(p);
  }
  return out;
}

function enclosingBraceOpen(src: string, idx: number): number | null {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const c = src[i];
    if (c === "}") depth += 1;
    else if (c === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function findTsOpacityDecls(
  src: string
): Array<{ raw: string; index: number }> {
  const decls: Array<{ raw: string; index: number }> = [];
  let match: RegExpExecArray | null;
  TS_OPACITY_DECL_RE.lastIndex = 0;
  while ((match = TS_OPACITY_DECL_RE.exec(src))) {
    const raw = match.groups?.value?.trim();
    if (raw === undefined) continue;
    decls.push({ raw, index: match.index });
  }
  return decls;
}

function scanTsFile(
  src: string,
  rel: string
): {
  counted: string[];
  classifiedAway: { pressOrHover: number; nonLiteral: number };
} {
  const counted: string[] = [];
  const classifiedAway = { pressOrHover: 0, nonLiteral: 0 };

  for (const decl of findTsOpacityDecls(src)) {
    const value = numericValue(decl.raw);
    if (value === null || !(value > 0 && value < 1)) {
      if (value === null) classifiedAway.nonLiteral += 1;
      continue;
    }

    const openIdx = enclosingBraceOpen(src, decl.index);
    const contextStart = Math.max(0, (openIdx ?? 0) - 120);
    const context =
      openIdx === null || openIdx === -1
        ? ""
        : src.slice(contextStart, openIdx);

    if (PRESS_CONTEXT_RE.test(context)) {
      classifiedAway.pressOrHover += 1;
      continue;
    }

    const line = lineOf(src, decl.index);
    const keyMatch = /(?<key>[A-Za-z_$][\w$]*)\s*:\s*$/u.exec(
      context.trimEnd()
    );
    const keyName = keyMatch?.groups?.key;
    const where = keyName
      ? `key "${keyName}"`
      : context.trim().slice(-40) || "(module scope)";
    counted.push(`${rel}:${line} — ${where} { opacity: ${decl.raw} }`);
  }

  return { counted, classifiedAway };
}

export type MobilePackageScan = {
  counted: string[];
  classifiedAway: { pressOrHover: number; nonLiteral: number };
  filesScanned: number;
  missingTarget?: string;
};

export function lintContainerOpacityMobile(
  root = ROOT,
  budgets: Record<string, number> = TS_BUDGETS
): Record<string, MobilePackageScan> {
  const perPackage: Record<string, MobilePackageScan> = {};
  for (const pkg of Object.keys(budgets)) {
    perPackage[pkg] = {
      counted: [],
      classifiedAway: { pressOrHover: 0, nonLiteral: 0 },
      filesScanned: 0,
    };
  }

  for (const pkg of Object.keys(budgets)) {
    const scan = perPackage[pkg];
    if (scan === undefined) continue;
    const dir = path.resolve(root, pkg);
    if (!existsSync(dir)) {
      scan.missingTarget = pkg;
      continue;
    }
    for (const file of walkExt(dir, TS_EXTENSION)) {
      const rel = path.relative(root, file);
      scan.filesScanned += 1;
      const src = blankJsComments(readFileSync(file, "utf8"));
      const { counted, classifiedAway } = scanTsFile(src, rel);
      scan.counted.push(...counted);
      scan.classifiedAway.pressOrHover += classifiedAway.pressOrHover;
      scan.classifiedAway.nonLiteral += classifiedAway.nonLiteral;
    }
  }

  return perPackage;
}
