/**
 * Declarative containment policy for the two least-trusted execution lanes in
 * the product: app handlers (`engine/worker/runner.ts`) and automation
 * handlers (`automation/worker/runner.ts`).
 *
 * WHAT THIS POLICY IS. A capability allowlist evaluated by an in-thread module
 * loader hook (`install.ts`). The rule is fail-closed: a builtin module is
 * reachable from the untrusted graph only if it is named here, and everything
 * that carries ambient authority — filesystem, sockets, subprocesses, native
 * addons, the process environment — is off unless the lane grants it.
 *
 * WHAT THIS POLICY IS NOT. It is not an OS sandbox and it is not a separate
 * V8 isolate. It constrains what JavaScript *running in this thread* can
 * reach; it cannot constrain code that has already escaped JavaScript. The
 * precise, per-mechanism limits are written down in `install.ts` and must be
 * read before anyone treats a lane as "sandboxed" in a threat model.
 */

import { realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

export type SandboxLane =
  | "app-handler"
  | "app-seed"
  | "automation-handler"
  | "media-transcode"
  | "model-runtime";

/** Read-only, root-confined filesystem grant. Writes are never granted. */
export interface FilesystemGrant {
  readonly mode: "read-confined";
  /** Absolute directory roots. A read resolving outside all of them is refused. */
  readonly readRoots: readonly string[];
}

export interface SandboxPolicy {
  readonly lane: SandboxLane;
  /**
   * Builtin ids (unprefixed, e.g. `"path"`) the untrusted graph may load.
   * Anything absent is refused — including `node:module`, which would
   * otherwise hand the graph a `createRequire` that skips these hooks.
   */
  readonly allowedBuiltins: readonly string[];
  readonly filesystem: "denied" | FilesystemGrant;
  /** `"denied"` revokes global fetch/WebSocket and the socket builtins. */
  readonly network: "denied";
  /**
   * `"denied"` revokes `child_process` and `process.binding`. `"allowed"` is
   * an explicit hole — the child is not in the sandbox, so nothing here
   * constrains it. Only `mediaTranscodePolicy` grants it; see its header.
   */
  readonly subprocess: "denied" | "allowed";
  /** `process.dlopen`. `true` is an explicit hole — see install.ts limits. */
  readonly nativeAddons: boolean;
  /** `"denied"` replaces `process.env` with a frozen empty object. */
  readonly environment: "denied" | "inherited";
}

/**
 * Builtins that compute but hold no ambient authority: no descriptor, no
 * socket, no subprocess, no loader reflection. This is the shared floor every
 * lane gets; a lane widens it only by naming a module and saying why.
 *
 * Deliberately absent, with reasons:
 *   `module`      — `createRequire` bypasses the loader hooks entirely.
 *   `process`     — re-acquires the process object after global revocation.
 *   `os`          — host fingerprinting (hostname, user, network interfaces).
 *   `v8`, `vm`    — heap serialization and a fresh un-hooked realm.
 *   `worker_threads` — spawns a sibling thread with no sandbox installed.
 *   `perf_hooks`  — high-resolution timing, and it is not needed by handlers.
 *   `inspector`   — opens a debugger channel into this process.
 */
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

/** The two filesystem ids the confined mirror stands in for. */
export const FS_BUILTIN = "fs";
export const FS_PROMISES_BUILTIN = "fs/promises";

/**
 * App handlers (queries / actions). Every first-party QUERY AND ACTION in
 * `packages/blueprints/apps/**` imports zero node builtins, so the
 * computational floor with no filesystem is not a theoretical tightening —
 * it is the shape that corpus already has.
 *
 * "Handler" here excludes seed modules, which do read their own bundled sample
 * assets; they get `appSeedPolicy` below. The original survey behind this lane
 * globbed the `.ts` handlers only and read the `.js` seeds as out of scope,
 * which is how demo seeding came to be refused.
 */
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

/**
 * Demo-scenario SEED modules (`packages/blueprints/apps/*\/seed.js`).
 *
 * A seed is dispatched through the same worker runner as a query or an action,
 * but it is not the same kind of code: it ships sample assets beside itself and
 * reads them off disk (`photos/seed.js` loads `sample/*` with `readFileSync`)
 * to build a believable first-run library. The app-handler lane refuses `fs`
 * outright, which is right for handlers and wrong for seeds — W7.1 landed that
 * lane on a corpus survey that read the `.ts` handlers and missed the `.js`
 * seeds, so demo seeding broke with `lane "app-handler" has no filesystem
 * grant`. This lane is the correction, kept SEPARATE from `appHandlerPolicy`
 * so restoring what seeds need never quietly hands it to every handler.
 *
 * The grant is the narrowest one that works: read-only, confined to the seed's
 * OWN app directory. That is not a meaningful widening even in principle — a
 * seed can already `import` anything in that directory, so being able to read
 * those same bytes adds no authority. What it still refuses is every sibling
 * app's directory, the vault, and the rest of the disk.
 */
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

/**
 * Automation handlers with no model weights (e.g. the `place-names`
 * recognition bundle, which documents itself as having "no import that opens a
 * socket, and no import that touches the filesystem"). Identical shape to the
 * app-handler lane; kept separate so widening one never silently widens both.
 */
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

/**
 * Automation handlers that load ONNX weights and the native runtime from
 * `packages/model-runtime/runtime/`.
 *
 * HONEST LIMIT: `nativeAddons: true` is a real hole and is named as one. A
 * native addon runs outside JavaScript, so once `process.dlopen` succeeds no
 * loader hook and no global revocation in this file constrains it. What this
 * lane still buys over an unsandboxed worker is narrow but real: reads are
 * confined to `readRoots`, writes are refused outright, sockets and
 * subprocesses are refused, and the environment is empty — so the *handler
 * JavaScript* around the model cannot exfiltrate what the model sees.
 */
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
 * The `model-runtime` lane plus a subprocess grant, for the one shipped bundle
 * that decodes media by shelling out to ffmpeg (`transcript`).
 *
 * A SEPARATE lane rather than a `subprocess` grant added to
 * `modelRuntimePolicy`, for the same reason `appSeedPolicy` is separate from
 * `appHandlerPolicy`: widening a lane to fit one tenant silently widens it for
 * every other tenant too, and four ONNX bundles run under `model-runtime` that
 * have no business spawning anything. Keeping them apart means the subprocess
 * grant is visible in the one place it applies, and `bundle-lane-conformance
 * .test.ts` asserts that exactly one bundle needs it.
 *
 * HONEST LIMIT, and it is a large one. `subprocess: "allowed"` means this lane
 * can start a process that no loader hook, no confined-fs mirror and no global
 * revocation in this file constrains — the child inherits nothing from the
 * sandbox because it is not in it. That is strictly worse containment than
 * `model-runtime`, and strictly better than the no-lane default it replaces
 * (#846 P9): the handler JavaScript around the spawn is still read-confined,
 * write-refused, socket-refused and environment-empty, so what it can hand the
 * child and what it can do with the result are both bounded. Retiring this lane
 * means moving media decoding out of the handler, not widening it further.
 */
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

/** Absolute, trailing-separator-free, de-duplicated roots. */
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

/**
 * Reduce a module specifier to its builtin id, or `null` when it does not name
 * a builtin. Both spellings are handled: ESM only resolves `node:fs`, but CJS
 * `require("fs")` inside a transitive dependency resolves the bare form, and
 * the hook sees both.
 */
export function builtinId(specifier: string): string | null {
  if (typeof specifier !== "string" || specifier === "") return null;
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (bare === "" || bare.startsWith(".") || bare.startsWith("/")) return null;
  // `node:`-prefixed is authoritative; bare needs to be a known builtin name so
  // a userland package called `crypto-js` is not mistaken for `crypto`.
  if (specifier.startsWith("node:")) return bare;
  return KNOWN_BUILTINS.has(bare) ? bare : null;
}

/**
 * Every builtin id Node exposes, used only to disambiguate the bare spelling.
 * Derived from `module.builtinModules` at import time so a new Node release
 * cannot introduce a builtin this file silently fails to recognize.
 */
const KNOWN_BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.map((name) =>
    name.startsWith("node:") ? name.slice(5) : name
  )
);

export type BuiltinDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "confined-fs"; readonly promises: boolean }
  | { readonly kind: "deny"; readonly reason: string };

/**
 * The one decision function. `install.ts` calls it for every specifier the
 * untrusted graph resolves; `policy.test.ts` calls it directly. Keeping the
 * ruling out of the hook is what makes the ruling testable without a thread.
 */
export function builtinDecision(
  policy: SandboxPolicy,
  id: string
): BuiltinDecision {
  if (id === FS_BUILTIN || id === FS_PROMISES_BUILTIN) {
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

/**
 * Is `target` inside one of `roots`?
 *
 * TOCTOU is real and named: the caller resolves symlinks before asking, so a
 * link swapped between this check and the syscall is not caught here. The
 * confined mirror in `confined-fs.ts` narrows the window by realpath-ing
 * immediately before each call, which is the best a userland wrapper can do —
 * closing it entirely needs an OS facility (see install.ts limits).
 */
export function isPathWithinRoots(
  target: string,
  roots: readonly string[]
): boolean {
  if (roots.length === 0) return false;
  const resolved = path.resolve(target);
  return roots.some((root) => {
    if (resolved === root) return true;
    // `path.relative`, not `startsWith(root + sep)`: the string form is wrong
    // for a root that already ends in the separator (a bare `/` would compare
    // against `//` and match nothing), and it is the idiom that also rejects
    // the `/srv/models-evil` sibling a naive prefix test would accept.
    const rel = path.relative(root, resolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}
