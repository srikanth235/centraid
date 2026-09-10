/**
 * Fail-closed capability allowlist. WHAT IT IS NOT: an OS sandbox — it binds
 * JavaScript in THIS THREAD, never what has escaped it. Read `install.ts`.
 */

import { realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

export type SandboxLane =
  | "app-handler"
  | "app-seed"
  | "automation-handler"
  | "media-transcode"
  | "model-runtime"
  | "system";

export interface FilesystemGrant {
  readonly mode: "read-confined";
  readonly readRoots: readonly string[];
}

export interface SandboxPolicy {
  readonly lane: SandboxLane;
  readonly allowedBuiltins: readonly string[];
  /** `"unrestricted"` is the SYSTEM lane alone: first-party code that already
   *  runs with the gateway's own filesystem reach. Every other lane is
   *  `"denied"` or a read-confined grant. */
  readonly filesystem: "denied" | "unrestricted" | FilesystemGrant;
  readonly network: "denied" | "allowed";
  readonly subprocess: "denied" | "allowed";
  readonly nativeAddons: boolean;
  readonly environment: "denied" | "inherited";
}

/** The shared floor: no ambient authority. Deliberately absent — `module`
 *  (`createRequire` bypasses the hooks), `process`, `os`, `v8`/`vm`,
 *  `worker_threads`, `inspector`. */
export const COMPUTATIONAL_BUILTINS: readonly string[] = Object.freeze([
  "assert",
  "assert/strict",
  "buffer",
  "crypto",
  "events",
  "path",
  "path/posix",
  "path/win32",
  "punycode",
  "querystring",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "url",
  "util",
  "util/types",
  "zlib",
]);

export const FS_BUILTIN = "fs";
export const FS_PROMISES_BUILTIN = "fs/promises";

export function appHandlerPolicy(): SandboxPolicy {
  return {
    lane: "app-handler",
    allowedBuiltins: COMPUTATIONAL_BUILTINS,
    filesystem: "denied",
    network: "denied",
    subprocess: "denied",
    nativeAddons: false,
    environment: "denied",
  };
}

export function appSeedPolicy(appDir: string): SandboxPolicy {
  return {
    lane: "app-seed",
    allowedBuiltins: [
      ...COMPUTATIONAL_BUILTINS,
      FS_BUILTIN,
      FS_PROMISES_BUILTIN,
    ],
    filesystem: { mode: "read-confined", readRoots: normalizeRoots([appDir]) },
    network: "denied",
    subprocess: "denied",
    nativeAddons: false,
    environment: "denied",
  };
}

export function automationHandlerPolicy(): SandboxPolicy {
  return {
    lane: "automation-handler",
    allowedBuiltins: COMPUTATIONAL_BUILTINS,
    filesystem: "denied",
    network: "denied",
    subprocess: "denied",
    nativeAddons: false,
    environment: "denied",
  };
}

/** HONEST LIMIT: past `process.dlopen` nothing here constrains the addon. */
export function modelRuntimePolicy(
  readRoots: readonly string[]
): SandboxPolicy {
  return {
    lane: "model-runtime",
    allowedBuiltins: [
      ...COMPUTATIONAL_BUILTINS,
      FS_BUILTIN,
      FS_PROMISES_BUILTIN,
    ],
    filesystem: { mode: "read-confined", readRoots: normalizeRoots(readRoots) },
    network: "denied",
    subprocess: "denied",
    nativeAddons: true,
    environment: "denied",
  };
}

/**
 * PROVENANCE TIER, NOT A CAPABILITY REQUEST. This lane is reachable only for an
 * automation id in `SYSTEM_AUTOMATION_IDS` (`enrich/system-recognition.ts`) —
 * shipped with the release, first-party code authored in this repo, present in
 * every vault. A manifest cannot ask for it: `automation/manifest/manifest.ts`
 * accepts only `model-runtime` and `media-transcode` under `sandbox.lane`, and
 * the routing decision is made by the PARENT from the id, never from anything
 * the bundle or its manifest declares.
 *
 * It grants nothing the gateway process does not already have: bundled
 * blueprint code is first-party shell code, and running it in-thread under the
 * same authority as `packages/server` is the honest description of what it is.
 * The security property that survives is the one that matters — nothing the
 * owner did not ship in the release ever reaches this lane. Bundled-but-optional
 * automations and (future) code-store automations stay exactly as confined as
 * they are today.
 */
export function systemAutomationPolicy(): SandboxPolicy {
  return {
    lane: "system",
    allowedBuiltins: ALL_BUILTINS,
    filesystem: "unrestricted",
    network: "allowed",
    subprocess: "allowed",
    nativeAddons: true,
    environment: "inherited",
  };
}

/** A SEPARATE lane, never a `subprocess` grant on `modelRuntimePolicy`, which
 *  would widen every bundle there. HONEST LIMIT: the child is unconstrained. */
export function mediaTranscodePolicy(
  readRoots: readonly string[]
): SandboxPolicy {
  const base = modelRuntimePolicy(readRoots);
  return {
    ...base,
    lane: "media-transcode",
    allowedBuiltins: [...base.allowedBuiltins, "child_process"],
    subprocess: "allowed",
  };
}

export function normalizeRoots(roots: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const root of roots) {
    if (typeof root !== "string" || root.trim() === "") continue;
    const absolute = path.resolve(root);
    let real = absolute;
    try {
      // macOS tmpdirs are `/var/folders` and `/private/var/folders` for the
      // same directory; confinement compares realpath(target) to these roots.
      real = realpathSync(absolute);
    } catch {
      // Granted before the directory exists — keep the resolved form.
    }
    seen.add(real);
  }
  return Object.freeze([...seen].sort());
}

export function builtinId(specifier: string): string | null {
  if (typeof specifier !== "string" || specifier === "") return null;
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (bare === "" || bare.startsWith(".") || bare.startsWith("/")) return null;
  // Check bare names so `crypto-js` is not read as `crypto`.
  if (specifier.startsWith("node:")) return bare;
  return KNOWN_BUILTINS.has(bare) ? bare : null;
}

/** Every builtin this Node carries — the system lane's allowlist is not a
 *  narrower list than the gateway's own. */
const ALL_BUILTINS: readonly string[] = Object.freeze(
  [
    ...new Set(
      builtinModules.map((name) =>
        name.startsWith("node:") ? name.slice(5) : name
      )
    ),
  ].sort()
);

const KNOWN_BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.map((name) =>
    name.startsWith("node:") ? name.slice(5) : name
  )
);

export type BuiltinDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "confined-fs"; readonly promises: boolean }
  | { readonly kind: "deny"; readonly reason: string };

export function builtinDecision(
  policy: SandboxPolicy,
  id: string
): BuiltinDecision {
  if (id === FS_BUILTIN || id === FS_PROMISES_BUILTIN) {
    // The system lane reads the real `node:fs`: the confined mirror is partial
    // by construction, and first-party code is not what it exists to bound.
    if (policy.filesystem === "unrestricted") return { kind: "allow" };
    if (policy.filesystem === "denied") {
      return {
        kind: "deny",
        reason: `builtin "node:${id}" is refused: lane "${policy.lane}" has no filesystem grant`,
      };
    }
    return { kind: "confined-fs", promises: id === FS_PROMISES_BUILTIN };
  }
  if (policy.allowedBuiltins.includes(id)) return { kind: "allow" };
  return {
    kind: "deny",
    reason: `builtin "node:${id}" is not in lane "${policy.lane}"'s allowlist`,
  };
}

/** TOCTOU: a symlink swapped after this check is not caught here. */
export function isPathWithinRoots(
  target: string,
  roots: readonly string[]
): boolean {
  if (roots.length === 0) return false;
  const resolved = path.resolve(target);
  return roots.some((root) => {
    if (resolved === root) return true;
    // `path.relative`, never `startsWith`: that accepts a `-evil` sibling.
    const rel = path.relative(root, resolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}
