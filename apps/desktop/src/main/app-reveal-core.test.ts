/*
 * APPS_OPEN hardening (issue #865): the renderer-supplied id is grammar-checked
 * BEFORE any path join, so traversal ids never reach shell.openPath (mocked
 * here — the core module is electron-free by design).
 */

import { describe, expect, it, vi } from "vitest";

import { openAppFolder } from "./app-reveal-core.js";
import { assertRevealableAppId } from "./ipc-core.js";

const deps = (
  overrides: {
    resolveDir?: (appId: string) => Promise<string>;
    openPath?: (dir: string) => Promise<string>;
  } = {}
) => ({
  resolveDir:
    overrides.resolveDir ??
    (async (appId: string) => `/code-store/active-main/apps/${appId}`),
  openPath: overrides.openPath ?? vi.fn<() => Promise<string>>(async () => ""),
});

describe("openAppFolder (issue #865)", () => {
  it("opens a well-formed app dir via shell.openPath", async () => {
    const openPath = vi.fn<() => Promise<string>>(async () => "");
    const result = await openAppFolder({ id: "notes" }, deps({ openPath }));
    expect(result).toStrictEqual({ ok: true });
    expect(openPath).toHaveBeenCalledExactlyOnceWith(
      "/code-store/active-main/apps/notes"
    );
  });

  it("surfaces shell.openPath's resolved error string", async () => {
    await expect(
      openAppFolder(
        { id: "notes" },
        deps({ openPath: async () => "Failed to open item" })
      )
    ).rejects.toThrow(/Could not open .*Failed to open item/u);
  });

  it("refuses traversal ids before any path is resolved", async () => {
    const resolveDir = vi.fn<(id: string) => Promise<string>>(
      async (id: string) => `/x/${id}`
    );
    const openPath = vi.fn<() => Promise<string>>(async () => "");
    await Promise.all(
      [
        "../../etc",
        "../..",
        "..",
        "notes/../../secrets",
        "/Users/someone/.ssh",
        "./notes",
      ].map(async (id) => {
        await expect(
          openAppFolder({ id }, deps({ resolveDir, openPath }))
        ).rejects.toThrow(/invalid app id/u);
      })
    );
    expect(resolveDir).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it("refuses ids outside the gateway app-id grammar", async () => {
    await Promise.all(
      [undefined, {}, { id: 42 }].map(async (input) => {
        await expect(openAppFolder(input, deps())).rejects.toThrow(
          /app open needs \{ id \}/u
        );
      })
    );
    await Promise.all(
      [
        { id: "" },
        { id: "Notes" },
        { id: "_shared" },
        { id: "a".repeat(64) },
        { id: "has space" },
        { id: "dot.dot" },
      ].map(async (input) => {
        await expect(openAppFolder(input, deps())).rejects.toThrow(
          /invalid app id/u
        );
      })
    );
    await expect(openAppFolder({ id: "a" }, deps())).resolves.toStrictEqual({
      ok: true,
    });
  });
});

describe("assertRevealableAppId (issue #865 backstop)", () => {
  it("mirrors the gateway grammar and reserved underscore prefix", () => {
    expect(() => assertRevealableAppId("agenda")).not.toThrow();
    expect(() => assertRevealableAppId("google-gmail-pull")).not.toThrow();
    expect(() => assertRevealableAppId("../etc")).toThrow(/invalid app id/u);
    expect(() => assertRevealableAppId("_shared")).toThrow(/invalid app id/u);
    expect(() => assertRevealableAppId("")).toThrow(/invalid app id/u);
  });
});
