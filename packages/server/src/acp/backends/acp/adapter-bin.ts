// An ACP adapter's stdio-server entry is its pinned npm package's `bin` —
// never `main` (a library entry) — launched via `process.execPath` (ESM).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);

const cache = new Map<string, string>();

/** Absolute path to `packageName`'s ACP-server entry; throws when not installed. */
export function resolveAdapterEntry(packageName: string): string {
  const hit = cache.get(packageName);
  if (hit) return hit;

  let manifestPath: string;
  try {
    manifestPath = require_.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(
      `ACP adapter "${packageName}" is not installed — reinstall @centraid/server/acp's dependencies.`
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const rel =
    typeof manifest.bin === "string"
      ? manifest.bin
      : Object.values(manifest.bin ?? {})[0];
  if (!rel) {
    throw new Error(`ACP adapter "${packageName}" declares no bin entry.`);
  }

  const entry = path.join(path.dirname(manifestPath), rel);
  cache.set(packageName, entry);
  return entry;
}
