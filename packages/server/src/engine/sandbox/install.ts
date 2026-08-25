/**
 * Installs the handler sandbox inside a worker thread, immediately before the
 * untrusted handler graph is imported.
 *
 * ============================ ENFORCEMENT MODEL ============================
 *
 * Two mechanisms, both in-process, both honest about their edges.
 *
 * (1) SYNCHRONOUS MODULE HOOKS — `module.registerHooks` (Node >= 22.15).
 *     Unlike `module.register`, these run on THIS thread and intercept BOTH
 *     `import` and CommonJS `require`, which matters because a transitive
 *     dependency of a handler is usually CJS. The hook tracks taint: the
 *     handler file is tainted, and anything resolved with a tainted parent
 *     becomes tainted too. Only tainted graphs are confined, so the worker
 *     runner's own imports, the TypeScript loader hooks, and the test harness
 *     are untouched. Inside a tainted graph a builtin is refused unless the
 *     lane allowlists it, and `fs` / `fs/promises` are rewritten to the
 *     read-only root-confined mirror in `confined-fs.ts`.
 *
 * (2) AMBIENT-AUTHORITY REVOCATION — the globals a module allowlist cannot
 *     reach: `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`,
 *     `navigator.sendBeacon`, `process.binding`, `process.dlopen`,
 *     `process.getBuiltinModule` (re-filtered through the same allowlist,
 *     since it is a documented loader bypass), `process.env`, and — because
 *     worker threads share the gateway's PID (#865) — `process.kill`,
 *     `process.abort`, and `process.report`, plus redacted `process.argv` /
 *     `process.execArgv` inside worker threads.
 *
 * ========================= WHAT IT DOES NOT ENFORCE =========================
 *
 * These are limits, not oversights. Do not describe a lane as sandboxed
 * without them.
 *
 *  - NOT AN OS SANDBOX. Handler code shares the gateway's process, address
 *    space, file descriptors, and uid. Anything that escapes JavaScript
 *    escapes all of this. A per-handler OS boundary needs a child process
 *    under seccomp/AppArmor (Linux), Seatbelt (macOS), or an AppContainer
 *    (Windows) — none of which a `worker_threads` thread can carry, because
 *    those facilities are per-process and Centraid runs handlers as threads
 *    for the sub-millisecond dispatch budget.
 *  - NOT A V8 ISOLATE. There is one heap. A handler can exhaust it (the
 *    `resourceLimits` on the pool bound that, crudely) and can observe timing.
 *  - NATIVE ADDONS DEFEAT IT ENTIRELY. When a lane sets `nativeAddons: true`
 *    (the model-runtime lane, which loads `onnxruntime-node`), `process.dlopen`
 *    stays live and the loaded `.node` binary is outside every check here.
 *  - FILESYSTEM CONFINEMENT IS USERLAND AND TOCTOU-EXPOSED. `confined-fs.ts`
 *    realpaths immediately before each syscall, which is the narrowest window
 *    a wrapper can achieve, not zero. Only an OS facility closes it.
 *  - THE MIRROR IS PARTIAL. An fs entry point the mirror does not export is
 *    `undefined` in the untrusted graph. Fail-closed, but it means a granted
 *    lane must be integration-tested against its real dependency graph.
 *  - REVOCATION IS THREAD-WIDE AND ONE-WAY. It is safe only because a pooled
 *    worker runs EXACTLY ONE handler and is then discarded
 *    (`engine/handlers/worker-pool.ts`). Reusing a worker would leak a
 *    revoked-global thread into unrelated code.
 *  - NODE < 22.15 HAS NO `registerHooks`. Installation THROWS there rather
 *    than returning a handle that enforces nothing.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

import { denied } from "./denied.js";
import { setConfinedReadRoots } from "./fs-guard.js";
import { builtinDecision, builtinId } from "./policy.js";
import type { SandboxPolicy } from "./policy.js";

export interface SandboxHandle {
  readonly policy: SandboxPolicy;
  /**
   * The real `fetch`, captured before revocation. The runner keeps this
   * private and exposes it only through the governed `ctx` rail, so network
   * reach is a capability the parent hands out rather than ambient authority
   * the handler already has.
   */
  readonly hostFetch: typeof globalThis.fetch;
  /** Mark a module URL untrusted; its whole transitive graph is confined. */
  readonly taint: (url: string) => void;
  /** Is this URL inside the confined graph? Exposed for assertions. */
  readonly isTainted: (url: string) => boolean;
}

/** Strip the `?query#hash` a loader may append before comparing identities. */
function bareUrl(url: string): string {
  const cut = Math.min(
    ...[url.indexOf("?"), url.indexOf("#")]
      .filter((i) => i >= 0)
      .concat([url.length])
  );
  return url.slice(0, cut);
}

/** Resolve a sibling sandbox module, preferring compiled `.js` over `.ts`. */
function siblingUrl(base: string): string {
  const js = new URL(`${base}.js`, import.meta.url);
  if (existsSync(fileURLToPath(js))) return js.href;
  return new URL(`${base}.ts`, import.meta.url).href;
}

const SANDBOX_DIR = new URL(".", import.meta.url).href;

let installed: SandboxHandle | undefined;

/**
 * Install the sandbox for this thread. Idempotent per thread: a second call
 * with the same policy returns the existing handle, and a second call with a
 * DIFFERENT policy throws — silently re-pointing a live sandbox at another
 * lane would be a containment bug wearing a convenience API.
 */
export function installWorkerSandbox(policy: SandboxPolicy): SandboxHandle {
  if (installed) {
    if (installed.policy.lane !== policy.lane) {
      throw denied(
        `thread already sandboxed for lane "${installed.policy.lane}"; refusing to re-install as "${policy.lane}"`
      );
    }
    return installed;
  }
  if (typeof registerHooks !== "function") {
    throw denied(
      "node:module.registerHooks is unavailable (needs Node >= 22.15); refusing to run untrusted handlers with no containment"
    );
  }

  const hostFetch = globalThis.fetch;
  const tainted = new Set<string>();
  const confinedFsUrl = siblingUrl("confined-fs");
  const confinedFsPromisesUrl = siblingUrl("confined-fs-promises");

  setConfinedReadRoots(
    policy.filesystem === "denied" ? [] : policy.filesystem.readRoots
  );

  /**
   * The redirect target for `node:fs` / `node:fs/promises`. `format` must be
   * `module-typescript` when the mirror resolves to a `.ts` source: this hook
   * supplies no transformed source, so Node still has to strip the types, and
   * declaring plain `module` makes the file fail to parse.
   */
  const confinedFsResolution = (
    promises: boolean
  ): { url: string; format: string; shortCircuit: true } => {
    const url = promises ? confinedFsPromisesUrl : confinedFsUrl;
    return {
      url,
      format: url.endsWith(".ts") ? "module-typescript" : "module",
      shortCircuit: true,
    };
  };

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      // Sandbox modules themselves must reach the real builtins — the confined
      // mirror is implemented in terms of them. They are never tainted.
      if (parent !== undefined && bareUrl(parent).startsWith(SANDBOX_DIR)) {
        return nextResolve(specifier, context);
      }
      if (parent === undefined || !tainted.has(bareUrl(parent))) {
        return nextResolve(specifier, context);
      }
      const id = builtinId(specifier);
      if (id !== null) {
        const decision = builtinDecision(policy, id);
        if (decision.kind === "deny") throw denied(decision.reason);
        if (decision.kind === "confined-fs") {
          return confinedFsResolution(decision.promises);
        }
        return nextResolve(specifier, context);
      }
      const resolved = nextResolve(specifier, context);
      // A userland specifier can still land on a builtin (an alias, a
      // re-export); re-check the resolved URL rather than trusting the input.
      if (resolved.url.startsWith("node:")) {
        const resolvedId = builtinId(resolved.url);
        if (resolvedId !== null) {
          const decision = builtinDecision(policy, resolvedId);
          if (decision.kind === "deny") throw denied(decision.reason);
          if (decision.kind === "confined-fs") {
            return confinedFsResolution(decision.promises);
          }
        }
      }
      tainted.add(bareUrl(resolved.url));
      return resolved;
    },
  });

  revokeAmbientAuthority(policy);

  installed = {
    policy,
    hostFetch,
    taint(url: string): void {
      tainted.add(
        bareUrl(url.startsWith("file:") ? url : pathToFileURL(url).href)
      );
    },
    isTainted(url: string): boolean {
      return tainted.has(
        bareUrl(url.startsWith("file:") ? url : pathToFileURL(url).href)
      );
    },
  };
  return installed;
}

/** Test-only: forget the per-thread install so a fresh policy can be applied. */
export function resetWorkerSandboxForTests(): void {
  installed = undefined;
}

function revokeAmbientAuthority(policy: SandboxPolicy): void {
  if (policy.network === "denied") {
    const revoke = (name: string) => () => {
      throw denied(
        `global ${name} is revoked in lane "${policy.lane}"; network reach is a capability the host grants through ctx, not ambient authority`
      );
    };
    const scope = globalThis as unknown as Record<string, unknown>;
    for (const name of [
      "fetch",
      "WebSocket",
      "EventSource",
      "XMLHttpRequest",
    ]) {
      if (name in scope) scope[name] = revoke(name);
    }
    const nav = scope.navigator as { sendBeacon?: unknown } | undefined;
    if (nav && typeof nav === "object" && "sendBeacon" in nav) {
      nav.sendBeacon = revoke("navigator.sendBeacon");
    }
  }

  const proc = process as unknown as Record<string, unknown>;
  if (policy.subprocess === "denied") {
    proc.binding = () => {
      throw denied(
        "process.binding is revoked; it reaches internal bindings the module allowlist cannot see"
      );
    };
  }
  if (!policy.nativeAddons) {
    proc.dlopen = () => {
      throw denied(
        `lane "${policy.lane}" may not load native addons; a .node binary runs outside every check this sandbox makes`
      );
    };
  }

  // `process.getBuiltinModule` is a documented loader bypass — it returns a
  // builtin without consulting any hook. Re-filter it through the same
  // decision function so the allowlist has exactly one meaning.
  const realGetBuiltinModule = process.getBuiltinModule.bind(process);
  proc.getBuiltinModule = (specifier: string): unknown => {
    const id = builtinId(specifier);
    if (id === null) return realGetBuiltinModule(specifier);
    const decision = builtinDecision(policy, id);
    if (decision.kind !== "allow") {
      throw denied(
        `process.getBuiltinModule("${specifier}") is refused: ${decision.kind === "deny" ? decision.reason : "filesystem access must go through the confined mirror, which this bypass would skip"}`
      );
    }
    return realGetBuiltinModule(specifier);
  };

  if (policy.environment === "denied") {
    Object.defineProperty(process, "env", {
      value: Object.freeze(Object.create(null) as Record<string, string>),
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }

  // Worker threads share the gateway's PID (#865). `process.kill` and
  // `process.abort` are process-wide — a SIGKILL from a handler would take
  // down every lane, the vault, and the tunnels with it, and no pool can
  // terminate its way out of that. No lane grants them; handlers are
  // untrusted, and subprocess lanes shell out through `child_process`, which
  // the allowlist already gates — never through these.
  proc.kill = () => {
    throw denied(
      "process.kill is revoked; worker threads share the gateway's PID, so a signal from an untrusted handler kills the whole gateway"
    );
  };
  proc.abort = () => {
    throw denied(
      "process.abort is revoked; it crashes the shared gateway process, not just this handler's thread"
    );
  };

  // `process.report.getReport()` reads the REAL OS environ at call time (#865),
  // straight past the frozen-empty `process.env` above, and would hand a
  // handler whatever the gateway process carries — S3 credentials, tunnel
  // tokens, provider keys. Undefined rather than stubbed so there is nothing
  // left on the object to reach.
  Object.defineProperty(process, "report", {
    value: undefined,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  // argv and execArgv echo how the gateway was launched (#865). Each thread
  // owns its own copy of these properties, so replacing them here cannot touch
  // the host process — but they are only replaced inside real worker threads:
  // this file also installs in-process under the test harness (a fork, where
  // `isMainThread` holds), and there `process.argv` is the harness's own
  // command line. Both production installers (`engine/worker/runner.ts`,
  // `automation/worker/runner.ts`) run as worker entries, so every production
  // install takes this branch.
  if (!isMainThread) {
    for (const name of ["argv", "execArgv"]) {
      Object.defineProperty(process, name, {
        value: Object.freeze([] as string[]),
        writable: false,
        configurable: false,
        enumerable: true,
      });
    }
  }
}
