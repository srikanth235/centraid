// #892 Phase 0 — the properties that make this key safe to cache an apk on.
//
// The failure this guards is silent by construction: a key that is stable when
// the JS changed produces a green, fast run against the wrong commit's bundle.
// So the assertions here are about MOVEMENT (content, rename, file set) rather
// than about any particular digest value.

import { describe, expect, it } from "vitest";

import {
  JS_BUNDLE_PATHSPECS,
  bundleInputFiles,
  digestFiles,
  isBundleInput,
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
    // Without the NUL delimiters, {"ab": ""} and {"a": "b"} would fold to the
    // same stream. A cache key that collides across a refactor is a stale apk.
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
    // Including them would make the two key components move together, which
    // collapses the apk cache into "rebuild on any change" — the state #535
    // spent a fingerprint escaping.
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
    // Sorted, so the digest cannot depend on git's enumeration order.
    expect([...files].sort()).toEqual(files);
  });

  it("hands the digest nothing the Hermes bundle could not contain", () => {
    // The live sweep, not a fixture: a pathspec added later without the filter
    // in mind would fail here rather than on a 21-minute Android lane (#931).
    expect(bundleInputFiles().filter((file) => !isBundleInput(file))).toEqual(
      []
    );
  });
});

describe("isBundleInput", () => {
  // #931 item 5. A test-only edit under a bundled workspace package moved this
  // key, missed the apk cache and paid a cold Android build (#934).
  const tracked = [
    "packages/blueprints/apps/locker/queries.ts",
    "packages/blueprints/apps/locker/queries.test.ts",
    "packages/blueprints/apps/locker/queries.test-fixtures.ts",
    "packages/blueprints/apps/locker/__tests__/helpers.ts",
    "packages/blueprints/apps/locker/README.md",
  ];
  const inputs = tracked.filter(isBundleInput);
  const at = (edited) => (file) => (file === edited ? "edited" : "original");

  it("keeps only what the bundle can contain", () => {
    expect(inputs).toEqual(["packages/blueprints/apps/locker/queries.ts"]);
  });

  it.each([
    "packages/blueprints/apps/locker/queries.test.ts",
    "packages/blueprints/apps/locker/queries.test-fixtures.ts",
    "packages/blueprints/apps/locker/__tests__/helpers.ts",
    "packages/blueprints/apps/locker/README.md",
  ])("leaves the fingerprint unchanged when %s is edited", (edited) => {
    expect(digestFiles(inputs, at(edited))).toBe(
      digestFiles(inputs, at("nothing"))
    );
  });

  it("still moves the fingerprint when the src file is edited", () => {
    expect(
      digestFiles(inputs, at("packages/blueprints/apps/locker/queries.ts"))
    ).not.toBe(digestFiles(inputs, at("nothing")));
  });
});
