import { existsSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { denied } from "./denied.js";
import { setConfinedReadRoots } from "./fs-guard.js";
import { builtinDecision, builtinId } from "./policy.js";
import type { SandboxPolicy } from "./policy.js";

export interface SandboxHandle {
  readonly policy: SandboxPolicy;
  readonly hostFetch: typeof globalThis.fetch;
  readonly taint: (url: string) => void;
  readonly isTainted: (url: string) => boolean;
}

function bareUrl(url: string): string {
  const cut = Math.min(
    ...[url.indexOf("?"), url.indexOf("#")]
      .filter((i) => i >= 0)
      .concat([url.length])
  );
  return url.slice(0, cut);
}

function canonicalFileUrl(url: string): string {
  const bare = bareUrl(url);
  if (!bare.startsWith("file:")) return bare;
  try {
    return pathToFileURL(realpathSync(fileURLToPath(bare))).href;
  } catch {
    return bare;
  }
}

function siblingUrl(base: string): string {
  const js = new URL(`${base}.js`, import.meta.url);
  if (existsSync(fileURLToPath(js))) return js.href;
  return new URL(`${base}.ts`, import.meta.url).href;
}

const SANDBOX_DIR = (() => {
  const resolved = canonicalFileUrl(new URL(".", import.meta.url).href);
  return resolved.endsWith("/") ? resolved : `${resolved}/`;
})();

let installed: SandboxHandle | undefined;

export function installWorkerSandbox(
  policy: SandboxPolicy,
  options?: { redactLaunchArgs?: boolean }
): SandboxHandle {
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
      if (
        parent !== undefined &&
        canonicalFileUrl(parent).startsWith(SANDBOX_DIR)
      ) {
        return nextResolve(specifier, context);
      }
      if (parent === undefined || !tainted.has(canonicalFileUrl(parent))) {
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
      tainted.add(canonicalFileUrl(resolved.url));
      return resolved;
    },
  });

  revokeAmbientAuthority(policy, options?.redactLaunchArgs === true);

  installed = {
    policy,
    hostFetch,
    taint(url: string): void {
      tainted.add(
        canonicalFileUrl(
          url.startsWith("file:") ? url : pathToFileURL(url).href
        )
      );
    },
    isTainted(url: string): boolean {
      return tainted.has(
        canonicalFileUrl(
          url.startsWith("file:") ? url : pathToFileURL(url).href
        )
      );
    },
  };
  return installed;
}

export function resetWorkerSandboxForTests(): void {
  installed = undefined;
}

function revokeAmbientAuthority(
  policy: SandboxPolicy,
  redactLaunchArgs: boolean
): void {
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

  const SIGNALS_DENIED = Symbol.for("centraid.sandbox.signalsDenied");
  (globalThis as Record<symbol, boolean>)[SIGNALS_DENIED] = true;
  const originalKill = process.kill.bind(process);
  try {
    proc.kill = (pid: number, signal?: string | number) => {
      if ((globalThis as Record<symbol, boolean>)[SIGNALS_DENIED] !== true)
        return originalKill(pid, signal);
      if (signal === 0) return originalKill(pid, 0);
      throw denied(
        "process.kill is revoked; worker threads share the gateway's PID, so a signal from an untrusted handler kills the whole gateway"
      );
    };
  } catch {
    // Intentionally empty.
  }
  const originalAbort = process.abort.bind(process);
  try {
    proc.abort = () => {
      if ((globalThis as Record<symbol, boolean>)[SIGNALS_DENIED] !== true) {
        originalAbort();
        return;
      }
      throw denied(
        "process.abort is revoked; it crashes the shared gateway process, not just this handler's thread"
      );
    };
  } catch {
    // Intentionally empty.
  }

  revokeDiagnosticReport(proc);

  if (redactLaunchArgs) {
    for (const name of ["argv", "execArgv"] as const) {
      const current = proc[name];
      if (!Array.isArray(current)) continue;
      if (name === "argv") {
        const bin = current[0];
        current.length = 0;
        if (typeof bin === "string" && bin.length > 0) current.push(bin);
      } else {
        current.length = 0;
      }
    }
  }
}

function redactedDiagnosticReport(): Record<string, unknown> {
  return {
    header: { event: "centraid-sandbox-redacted", filename: "" },
    javascriptStack: { message: "", stack: [] },
    javascriptHeap: {},
    nativeStack: [],
    resourceUsage: {},
    uvthreadResourceUsage: {},
    libuv: [],
    workers: [],
    environmentVariables: Object.create(null) as Record<string, string>,
    userLimits: {},
    sharedObjects: [],
  };
}

function revokeDiagnosticReport(proc: Record<string, unknown>): void {
  const getReport = (): Record<string, unknown> => redactedDiagnosticReport();
  const writeReport = (): string => "";
  const installOn = (report: Record<string, unknown>): void => {
    for (const [name, value] of [
      ["getReport", getReport],
      ["writeReport", writeReport],
    ] as const) {
      try {
        report[name] = value;
      } catch {
        try {
          Object.defineProperty(report, name, {
            value,
            writable: false,
          });
        } catch {
          // Intentionally empty.
        }
      }
    }
  };
  const report = proc.report as Record<string, unknown> | undefined;
  if (report && typeof report === "object") {
    installOn(report);
    return;
  }
  try {
    Object.defineProperty(process, "report", {
      value: { getReport, writeReport },
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch {
    // Intentionally empty.
  }
}
