/*
 * Installing the sandbox, in this thread (#842 W7.1).
 *
 * `install.ts` is the enforcement core — the module hook that refuses a
 * builtin, the taint set that decides which graph is confined, and the
 * ambient-authority revocation. It was reachable only through real worker
 * threads (`sandbox-escape.test.ts` spawns them), which V8 coverage does not
 * instrument, so the single most security-critical file in the slice was
 * measured at 0%.
 *
 * WHY IT IS SAFE TO INSTALL HERE. Installation is thread-wide and one-way:
 * globals are revoked and never restored, which is why the runner discards a
 * worker after one handler. Vitest runs each test FILE in its own isolated
 * environment, so this file owns the thread it dirties and no other suite
 * inherits it. `resetWorkerSandboxForTests` exists for exactly this, and this
 * file is deliberately the only caller — keep it that way, and keep this file
 * free of anything that needs a live `fetch` or `process.env` after the first
 * install.
 *
 * WHAT THIS FILE CANNOT REACH. The resolve hook's own body stays uncovered
 * here, and deliberately so: Vitest routes `import()` inside a test through its
 * own module runner, so `registerHooks` never sees the specifier and a
 * confinement assertion written against it would pass whether the hook worked
 * or not. That path is owned by `sandbox-escape.test.ts`, which spawns real
 * worker threads and is the only honest place to assert it. A vacuous test
 * here would be worse than the gap.
 */

import { describe, expect, test } from "vitest";

import { SandboxDeniedError } from "./denied.js";
import { installWorkerSandbox, resetWorkerSandboxForTests } from "./install.js";
import { appHandlerPolicy, appSeedPolicy } from "./policy.js";

describe(installWorkerSandbox, () => {
  test("captures the host fetch before revoking it", () => {
    resetWorkerSandboxForTests();
    const before = globalThis.fetch;
    const handle = installWorkerSandbox(appHandlerPolicy());
    // The runner hands network reach out through the governed `ctx` rail. If
    // the handle did not capture the real fetch BEFORE revocation, that rail
    // would be wired to the revoked stub and every granted call would throw.
    expect(handle.hostFetch).toBe(before);
    expect(handle.policy.lane).toBe("app-handler");
  });

  test("revokes ambient network authority in a denied lane", () => {
    // Same thread, already installed above — revocation is one-way, so this
    // observes the state the first install left.
    expect(() => globalThis.fetch("https://example.invalid")).toThrow(
      SandboxDeniedError
    );
  });

  test("taint is transitive-by-marking and observable", () => {
    const handle = installWorkerSandbox(appHandlerPolicy());
    const url = "file:///tmp/centraid-untrusted/handler.js";
    expect(handle.isTainted(url)).toBe(false);
    handle.taint(url);
    expect(handle.isTainted(url)).toBe(true);
    // A loader may append `?query#hash` to a specifier; identity must survive
    // it, or a handler could shed its taint by importing itself with a suffix.
    expect(handle.isTainted(`${url}?v=2`)).toBe(true);
    expect(handle.isTainted(`${url}#frag`)).toBe(true);
    // A sibling that was never marked stays trusted.
    expect(handle.isTainted("file:///tmp/centraid-untrusted/other.js")).toBe(
      false
    );
  });

  test("a second install for the SAME lane returns the same handle", () => {
    const first = installWorkerSandbox(appHandlerPolicy());
    const second = installWorkerSandbox(appHandlerPolicy());
    expect(second).toBe(first);
  });

  test("REFUSAL: re-installing for a DIFFERENT lane throws", () => {
    // Silently re-pointing a live sandbox at another lane is a containment bug
    // wearing a convenience API: the graph already loaded under the old lane
    // would keep running with the new lane's grants.
    expect(() =>
      installWorkerSandbox(appSeedPolicy("/tmp/centraid-seed"))
    ).toThrow(/already sandboxed for lane "app-handler"/u);
  });
});

describe("ambient-authority revocation", () => {
  // These observe the state the install in the block above left behind:
  // revocation is thread-wide and one-way, which is the whole reason a pooled
  // worker runs one handler and is then discarded.

  test("process.getBuiltinModule re-filters through the same allowlist", () => {
    // The documented loader bypass: it returns a builtin WITHOUT consulting any
    // module hook. If it were left alone, `process.getBuiltinModule("fs")`
    // would hand an untrusted graph the real filesystem past every check in
    // this file, so it is re-filtered rather than revoked.
    const get = process.getBuiltinModule.bind(process);
    // Allowed by the computational floor.
    expect(get("path")).toBeDefined();
    expect(get("node:path")).toBeDefined();
    // Refused: the app-handler lane grants no filesystem.
    expect(() => get("fs")).toThrow(/getBuiltinModule\("fs"\) is refused/u);
    expect(() => get("node:fs")).toThrow(SandboxDeniedError);
    // Refused for the same reason a hook would refuse it — reaching internals.
    expect(() => get("child_process")).toThrow(SandboxDeniedError);
    // Not a builtin at all: passed straight through to the real function,
    // which answers `undefined`. The filter must neither claim it as a refusal
    // nor invent a module — a relative specifier is the loader hook's business,
    // not this bypass's.
    expect(get("./local.js")).toBeUndefined();
    expect(get("lodash")).toBeUndefined();
  });

  test("subprocess and native-addon doors are revoked", () => {
    const proc = process as unknown as {
      binding: () => unknown;
      dlopen: () => unknown;
    };
    expect(() => proc.binding()).toThrow(/process.binding is revoked/u);
    expect(() => proc.dlopen()).toThrow(/may not load native addons/u);
  });

  test("kill, abort, and report are revoked in every lane (#865)", () => {
    // Worker threads share the gateway's PID, so kill/abort/report cannot be a
    // lane grant at all — the same way getBuiltinModule is re-filtered rather
    // than trusted. These observe the one install this thread already carries.
    const proc = process as unknown as {
      kill: (...args: unknown[]) => unknown;
      abort: () => unknown;
      report: unknown;
    };
    expect(() => proc.kill(process.pid, "SIGKILL")).toThrow(SandboxDeniedError);
    expect(() => proc.kill(process.pid, "SIGKILL")).toThrow(
      /share the gateway's PID/u
    );
    expect(() => proc.abort()).toThrow(SandboxDeniedError);
    expect(() => proc.abort()).toThrow(/crashes the shared gateway process/u);
    // Stub getReport on the host object rather than wiping `process.report`:
    // Electron's crash reporter reads the property, and replacing it with
    // undefined hung handler workers. The real OS environ is still unreachable.
    const report = proc.report as { getReport: () => unknown };
    expect(() => report.getReport()).toThrow(SandboxDeniedError);
    expect(() => report.getReport()).toThrow(/getReport is revoked/u);
  });

  test("the environment is replaced with a frozen empty object", () => {
    // Not merely emptied: a writable `{}` would let a handler stash state
    // across the one run it gets, and a configurable property would let it
    // restore the real env.
    expect(Object.keys(process.env)).toHaveLength(0);
    expect(Object.isFrozen(process.env)).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(process, "env");
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
  });
});
