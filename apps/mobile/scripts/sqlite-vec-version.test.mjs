import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

const mobileRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(mobileRoot, "..", "..");

/**
 * ONE sqlite-vec VERSION ACROSS TWO PLATFORMS (#996).
 *
 * expo-sqlite 57.0.2 pre-bundles sqlite-vec for Android as
 * `android/vec/<abi>/vec.so` and ships nothing for iOS, so iOS builds its own
 * from source in `build-sqlite-vec-ios.sh`. Two artifacts from two places is
 * exactly the shape that drifts: an expo-sqlite bump moves the `.so` and leaves
 * the tag in the shell script pointing at whatever it always did, and the first
 * evidence would be a vector query answering differently on one phone than the
 * other. Nothing in either build checks the other, so this does.
 *
 * The `.so` carries its version as a plain string (sqlite-vec's `vec_version()`
 * returns it), which is the only place the tarball states what it bundled — the
 * package.json says nothing about it.
 */
const TAG_LINE = /^TAG="(?<tag>v[^"]+)"$/mu;
const VERSION = /v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?/gu;

describe("sqlite-vec version agreement", () => {
  test("the iOS build tag is the version Expo bundles for Android", async () => {
    const script = await readFile(
      path.join(mobileRoot, "scripts", "build-sqlite-vec-ios.sh"),
      "utf8"
    );
    const tag = TAG_LINE.exec(script)?.groups?.tag;
    expect(tag, "build-sqlite-vec-ios.sh must pin a TAG").toBeTruthy();

    // latin1 so every byte of the ELF maps to a character; the version is an
    // ASCII string in .rodata either way.
    const bundled = await readFile(
      path.join(
        repoRoot,
        "node_modules",
        "expo-sqlite",
        "android",
        "vec",
        "arm64-v8a",
        "vec.so"
      ),
      "latin1"
    );
    const matches = bundled.match(VERSION) ?? [];
    const versions = [...new Set(matches)];
    expect(
      versions,
      "expo-sqlite's bundled vec.so states exactly one version"
    ).toEqual([tag]);
  });
});
