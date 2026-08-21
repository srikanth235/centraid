/**
 * Path confinement shared by the two halves of the filesystem mirror
 * (`confined-fs.ts` and `confined-fs-promises.ts`). It owns the granted roots
 * and the one check every mirrored entry point runs before touching disk.
 *
 * The real `node:fs` is imported here and that import is not confined — this
 * is trusted sandbox code, and the hook in `install.ts` only confines graphs
 * rooted at the untrusted handler file.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

import { deniedPath } from "./denied.js";
import { isPathWithinRoots, normalizeRoots } from "./policy.js";

let roots: readonly string[] = Object.freeze([]);

/**
 * Set by `installWorkerSandbox` before the untrusted graph loads. Calling it
 * with an empty list leaves the mirror refusing everything, which is the
 * correct failure direction.
 */
export function setConfinedReadRoots(next: readonly string[]): void {
  roots = normalizeRoots(next);
}

/** Current roots — for assertions in tests and for the denial message. */
export function confinedReadRoots(): readonly string[] {
  return roots;
}

/** Coerce the path-ish first argument of an fs call to a string. */
function toPathString(target: unknown): string | null {
  if (typeof target === "string") return target;
  if (target instanceof URL) return target.pathname;
  if (Buffer.isBuffer(target)) return target.toString("utf8");
  return null;
}

/**
 * Resolve a path argument to a real, absolute path and check it against the
 * roots. Symlinks are followed via `realpathSync`, so a link *inside* a root
 * that points outside it is refused rather than followed. When the target does
 * not exist, its nearest existing ancestor is realpath-ed instead — otherwise
 * a probe for a non-existent file would skip the check entirely.
 *
 * TOCTOU is real and named: a link swapped between this check and the syscall
 * is not caught. Realpath-ing immediately before each call is the narrowest
 * window a userland wrapper can achieve; closing it needs an OS facility.
 */
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
      // Walked to the filesystem root without finding an existing ancestor.
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
