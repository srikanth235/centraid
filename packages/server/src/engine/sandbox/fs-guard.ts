import { realpathSync } from "node:fs";
import path from "node:path";

import { deniedPath } from "./denied.js";
import { isPathWithinRoots, normalizeRoots } from "./policy.js";

let roots: readonly string[] = Object.freeze([]);

/** Empty roots refuse everything — correct failure direction. */
export function setConfinedReadRoots(next: readonly string[]): void {
  roots = normalizeRoots(next);
}

export function confinedReadRoots(): readonly string[] {
  return roots;
}

function toPathString(target: unknown): string | null {
  if (typeof target === "string") return target;
  if (target instanceof URL) return target.pathname;
  if (Buffer.isBuffer(target)) return target.toString("utf8");
  return null;
}

/** Links out of a root are refused after realpath; missing targets check via
 *  their nearest existing ancestor, else probes skip; TOCTOU swaps uncaught. */
export function guardReadPath(operation: string, target: unknown): string {
  const raw = toPathString(target);
  if (raw === null) throw deniedPath(operation, String(target), roots);
  const absolute = path.resolve(raw);
  let probe = absolute;
  let suffix = "";
  for (;;) {
    let real: string | undefined;
    try {
      real = realpathSync(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) throw deniedPath(operation, absolute, roots);
      suffix =
        suffix === ""
          ? path.basename(probe)
          : path.join(path.basename(probe), suffix);
      probe = parent;
      continue;
    }
    const candidate = suffix === "" ? real : path.join(real, suffix);
    if (!isPathWithinRoots(candidate, roots)) {
      throw deniedPath(operation, absolute, roots);
    }
    return absolute;
  }
}
