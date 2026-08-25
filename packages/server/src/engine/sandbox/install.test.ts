/*
 * Installing the sandbox in THIS thread (#842). Installation is thread-wide and
 * one-way; Vitest isolates each file, so this one owns the thread it dirties —
 * keep it the only caller of `resetWorkerSandboxForTests`. The resolve hook's
 * body is not coverable here; `sandbox-escape.test.ts` owns it.
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

  test("the environment is replaced with a frozen empty object", () => {
    expect(Object.keys(process.env)).toHaveLength(0);
    expect(Object.isFrozen(process.env)).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(process, "env");
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
  });
});
