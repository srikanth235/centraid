import { describe, expect, it } from "vitest";

import {
  JS_BUNDLE_PATHSPECS,
  bundleInputFiles,
  digestFiles,
} from "./js-bundle-fingerprint.mjs";

const read = (contents) => (file) => contents[file] ?? "";

describe("digestFiles", () => {
  it("moves when a file's content changes", () => {
    const files = ["apps/mobile/src/a.ts"];
    const before = digestFiles(files, read({ "apps/mobile/src/a.ts": "one" }));
    const after = digestFiles(files, read({ "apps/mobile/src/a.ts": "two" }));
    expect(after).not.toBe(before);
  });

  it("moves on a pure rename, because Metro resolves paths", () => {
    const contents = { "a.ts": "same", "b.ts": "same" };
    expect(digestFiles(["a.ts"], read(contents))).not.toBe(
      digestFiles(["b.ts"], read(contents))
    );
  });

  it("moves when a file is added or removed", () => {
    const contents = { "a.ts": "x", "b.ts": "y" };
    expect(digestFiles(["a.ts"], read(contents))).not.toBe(
      digestFiles(["a.ts", "b.ts"], read(contents))
    );
  });

  it("cannot be forged by shifting bytes across a file boundary", () => {
    expect(digestFiles(["ab"], read({ ab: "" }))).not.toBe(
      digestFiles(["a"], read({ a: "b" }))
    );
  });

  it("is stable for identical input", () => {
    const contents = { "a.ts": "x" };
    expect(digestFiles(["a.ts"], read(contents))).toBe(
      digestFiles(["a.ts"], read(contents))
    );
  });
});

describe("JS_BUNDLE_PATHSPECS", () => {
  it("excludes the native projects, which native-fingerprint.mjs owns", () => {
    expect(
      JS_BUNDLE_PATHSPECS.some((spec) =>
        /^apps\/mobile\/(?<native>android|ios)\b/u.test(spec)
      )
    ).toBe(false);
  });

  it("covers the app source and every workspace package the phone imports", () => {
    for (const required of [
      "apps/mobile/src",
      "packages/client/src",
      "packages/core/src",
      "packages/design/src",
      "packages/blueprints/src",
      "bun.lock",
    ]) {
      expect(JS_BUNDLE_PATHSPECS).toContain(required);
    }
  });
});

describe("bundleInputFiles", () => {
  it("resolves a non-trivial tracked file set in this repo", () => {
    const files = bundleInputFiles();
    expect(files.length).toBeGreaterThan(100);
    expect([...files].sort()).toEqual(files);
  });
});
