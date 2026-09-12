// Shared scan helpers for engine conformance (#1018 split).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { blankComments } from "./lib/disabled-controls.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".expo",
  ".next",
]);

export type SurfaceFile = { label: string; code: string };

/** Every surface tree a blueprint app or a client shell lives in. */
export const SOURCE_ROOTS = [
  path.join("packages", "blueprints", "apps"),
  path.join("packages", "client", "src"),
  path.join("apps", "mobile", "src"),
  path.join("apps", "web", "src"),
];

export function walk(directory: string, out: string[] = []): string[] {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) walk(absolute, out);
    else if (/\.(?:ts|tsx)$/u.test(absolute)) out.push(absolute);
  }
  return out;
}

/** Every scanned file, as `{ label, code }` with comments blanked (string
 *  bodies intact — these checks read attribute values). */
export function surfaceFiles(root = ROOT) {
  const files: SurfaceFile[] = [];
  for (const rel of SOURCE_ROOTS) {
    for (const absolute of walk(path.join(root, rel))) {
      files.push({
        label: path.relative(root, absolute),
        code: blankComments(readFileSync(absolute, "utf8")),
      });
    }
  }
  return files;
}

/** Line number of a byte offset, 1-based. */
export const lineOf = (code: string, index: number) =>
  code.slice(0, index).split("\n").length;

/** Quoted literals out of a `const NAME = [...]` array, by source scan — the
 *  same technique `placement-registry.test.ts` uses on vault's closure. */
export function literalArray(file: string, name: string) {
  const source = readFileSync(file, "utf8");
  // `= [` specifically — a type annotation may itself end in `[]`
  // (`readonly PlacementEntity[]`), so the opening bracket is found from the
  // assignment onwards, never from the declaration's start.
  const match = source.match(new RegExp(`const ${name}[^=]*=\\s*\\[`, "u"));
  if (!match || match.index === undefined)
    throw new Error(`${name} not found in ${file}`);
  const start = match.index + match[0].length - 1;
  const end = source.indexOf("];", start);
  if (end === -1)
    throw new Error(`${name} in ${file} has no \`];\` terminator`);
  const body = source.slice(start, end);
  return [...body.matchAll(/"(?<name>[^"]+)"/gu)].map((m) => m[1]);
}
