// Lets a handler worker import TypeScript: production runs compiled dist
// under plain Node (runner.ts). `load` compiles via esbuild; `resolve` fills
// extensionless/`.js` siblings.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

interface ResolveContext {
  parentURL?: string;
  conditions: readonly string[];
  importAttributes: Record<string, string>;
}
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type NextResolve = (
  specifier: string,
  context: ResolveContext
) => ResolveResult | Promise<ResolveResult>;

interface LoadContext {
  format?: string | null;
  conditions: readonly string[];
  importAttributes: Record<string, string>;
}
interface LoadResult {
  format: string;
  source?: string | ArrayBuffer | Uint8Array;
  shortCircuit?: boolean;
}
type NextLoad = (
  url: string,
  context: LoadContext
) => LoadResult | Promise<LoadResult>;

const TS_URL_RE = /\.tsx?$/u;

/** On-disk TS URLs for an unresolved relative specifier. */
function tsCandidates(specifier: string, parentURL: string): string[] {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return [];
  const bases: string[] = [];
  if (specifier.endsWith(".js")) {
    // Source names the emitted `.js`; disk holds `.ts`.
    bases.push(specifier.slice(0, -3));
  } else if (path.extname(specifier) === "") {
    bases.push(specifier);
  }
  const urls: string[] = [];
  for (const base of bases) {
    for (const ext of [".ts", ".tsx"]) {
      const candidate = new URL(base + ext, parentURL);
      if (existsSync(fileURLToPath(candidate))) urls.push(candidate.href);
    }
  }
  return urls;
}

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve
): Promise<ResolveResult> {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (context.parentURL) {
      const [first] = tsCandidates(specifier, context.parentURL);
      if (first) return { url: first, format: "module", shortCircuit: true };
    }
    throw error;
  }
}

export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad
): Promise<LoadResult> {
  if (!TS_URL_RE.test(url)) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const source = await readFile(file, "utf8");
  const { code } = await esbuild.transform(source, {
    loader: url.endsWith(".tsx") ? "tsx" : "ts",
    format: "esm",
    sourcefile: file,
    // Automatic JSX runtime; inert for `.ts`.
    jsx: "automatic",
  });
  return { format: "module", source: code, shortCircuit: true };
}
