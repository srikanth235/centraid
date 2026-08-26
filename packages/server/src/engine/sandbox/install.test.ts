/*
 * Installing the sandbox in THIS thread (#842). Installation is thread-wide and
 * one-way; Vitest isolates each file, so this one owns the thread it dirties —
 * keep it the only caller of `resetWorkerSandboxForTests`. The resolve hook's
 * body is not coverable here; `sandbox-escape.test.ts` owns it.
 */

import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { SandboxDeniedError } from "./denied.js";
import { installWorkerSandbox, resetWorkerSandboxForTests } from "./install.js";
import { appHandlerPolicy, appSeedPolicy } from "./policy.js";

describe(installWorkerSandbox, () => {
  test("captures the host fetch before revoking it", () => {
    resetWorkerSandboxForTests();
    const before = globalThis.fetch;
    const handle = installWorkerSandbox(appHandlerPolicy());
    expect(handle.hostFetch).toBe(before);
    expect(handle.policy.lane).toBe("app-handler");
  });

  test("revokes ambient network authority in a denied lane", () => {
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
    // Identity survives `?query#hash`, or a handler sheds its taint.
    expect(handle.isTainted(`${url}?v=2`)).toBe(true);
    expect(handle.isTainted(`${url}#frag`)).toBe(true);
    expect(handle.isTainted("file:///tmp/centraid-untrusted/other.js")).toBe(
      false
    );
  });

  test("taint identity survives macOS /var vs /private aliases of the same file", () => {
    // os.tmpdir() on macOS is `/var/folders/...` while Node's loader reports
    // `file:///private/var/folders/...`. The desktop e2e vault lives there;
    // a taint mark that does not round-trip through realpath never matches
    // parentURL and the handler graph runs unsandboxed.
    const handle = installWorkerSandbox(appHandlerPolicy());
    const dir = tempDirSync("sandbox-taint-");
    const file = path.join(dir, "handler.js");
    writeFileSync(file, "");
    const logical = pathToFileURL(file).href;
    const canonical = pathToFileURL(realpathSync(file)).href;
    handle.taint(logical);
    expect(handle.isTainted(logical)).toBe(true);
    expect(handle.isTainted(canonical)).toBe(true);
  });

  test("a second install for the SAME lane returns the same handle", () => {
    const first = installWorkerSandbox(appHandlerPolicy());
    const second = installWorkerSandbox(appHandlerPolicy());
    expect(second).toBe(first);
  });

  test("REFUSAL: re-installing for a DIFFERENT lane throws", () => {
    expect(() =>
      installWorkerSandbox(appSeedPolicy("/tmp/centraid-seed"))
    ).toThrow(/already sandboxed for lane "app-handler"/u);
  });
});

describe("ambient-authority revocation", () => {
  test("process.getBuiltinModule re-filters through the same allowlist", () => {
    // A documented loader bypass: it consults no module hook.
    const get = process.getBuiltinModule.bind(process);
    expect(get("path")).toBeDefined();
    expect(get("node:path")).toBeDefined();
    expect(() => get("fs")).toThrow(/getBuiltinModule\("fs"\) is refused/u);
    expect(() => get("node:fs")).toThrow(SandboxDeniedError);
    expect(() => get("child_process")).toThrow(SandboxDeniedError);
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
    // Existence probes (signal 0) stay live — worker internals use them.
    expect(() => proc.kill(process.pid, 0)).not.toThrow();
    expect(() => proc.abort()).toThrow(SandboxDeniedError);
    expect(() => proc.abort()).toThrow(/crashes the shared gateway process/u);
    // getReport stays callable (Electron's crash reporter invokes it) but
    // must not dump the real OS environ around the frozen process.env.
    const report = proc.report as {
      getReport: () => { environmentVariables?: Record<string, string> };
      writeReport: () => string;
    };
    const dumped = report.getReport();
    expect(Object.keys(dumped.environmentVariables ?? {})).toHaveLength(0);
    expect(report.writeReport()).toBe("");
  });

  test("the environment is replaced with a frozen empty object", () => {
    expect(Object.keys(process.env)).toHaveLength(0);
    expect(Object.isFrozen(process.env)).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(process, "env");
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
  });
});
