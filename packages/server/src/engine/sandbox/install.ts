/**
 * Installs the handler sandbox in a worker thread, immediately before the
 * untrusted handler graph is imported. Two in-process mechanisms:
 *
 * (1) SYNCHRONOUS MODULE HOOKS (`module.registerHooks`, Node >= 22.15) run on
 *     THIS thread and intercept `import` AND `require` — handler dependencies
 *     are usually CJS. Taint spreads from the handler file down, so only
 *     tainted graphs are confined; the runner, TS loader and tests are not.
 * (2) AMBIENT-AUTHORITY REVOCATION covers what no module allowlist reaches:
 *     the network globals and the `process` loader/env escapes.
 *
 * WHAT IT DOES NOT ENFORCE — never call a lane sandboxed without these:
 *  - Not an OS sandbox. Handlers share the process, fds and uid; a real
 *    boundary needs a child process, which the dispatch budget forbids.
 *  - Not a V8 isolate: one heap, observable timing, only `resourceLimits`.
 *  - Native addons defeat it entirely (`nativeAddons: true` keeps `dlopen`).
 *  - Filesystem confinement is userland and TOCTOU-exposed.
 *  - The fs mirror is partial: unexported entry points are `undefined`, so a
 *    granted lane must be integration-tested against its real graph.
 *  - Revocation is thread-wide and one-way, safe ONLY because a pooled worker
 *    runs exactly one handler and is then discarded.
 *  - Node < 22.15 throws here rather than enforcing nothing.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { denied } from "./denied.js";
import { setConfinedReadRoots } from "./fs-guard.js";
import { builtinDecision, builtinId } from "./policy.js";
import type { SandboxPolicy } from "./policy.js";

export interface SandboxHandle {
  readonly policy: SandboxPolicy;
  /** Captured before revocation; reachable only through the governed `ctx`
   * rail, so network access stays a granted capability. */
  readonly hostFetch: typeof globalThis.fetch;
  /** Confines the URL's whole transitive graph. */
  readonly taint: (url: string) => void;
  readonly isTainted: (url: string) => boolean;
}

/** Strip the `?query#hash` a loader may append. */
function bareUrl(url: string): string {
  const cut = Math.min(
    ...[url.indexOf("?"), url.indexOf("#")]
      .filter((i) => i >= 0)
      .concat([url.length])
  );
  return url.slice(0, cut);
}

/** Prefers compiled `.js` over `.ts`. */
function siblingUrl(base: string): string {
  const js = new URL(`${base}.js`, import.meta.url);
  if (existsSync(fileURLToPath(js))) return js.href;
  return new URL(`${base}.ts`, import.meta.url).href;
}

const SANDBOX_DIR = new URL(".", import.meta.url).href;

let installed: SandboxHandle | undefined;

/** Idempotent per thread; a DIFFERENT policy throws — re-pointing a live
 * sandbox at another lane is a containment bug wearing a convenience API. */
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

  /** `format` must be `module-typescript` for a `.ts` mirror: this hook
   * supplies no source, so Node still strips the types itself. */
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
      // The mirror is built on the real builtins: never taint sandbox modules.
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
      // An alias or re-export can land on a builtin: re-check the resolved URL.
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

  // A documented loader bypass: re-filter it through the same decision
  // function so the allowlist has exactly one meaning.
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
}
