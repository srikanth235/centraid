// THE FLAGS HAVE TO REACH THE BUILD, AND NOTHING HERE RUNS `expo prebuild`.
//
// `app.config.ts`'s expo-sqlite plugin block is what a prebuild would READ; the
// committed `android/` and `ios/` projects are what actually gets compiled. No
// lane in this repo regenerates them, so a flag set only in the plugin block is
// INERT — Android would ship the vendored 3.50.3 with no SQLCipher and no
// fts5, and the phone would silently stop being the 3.49.1 seat every byte the
// gateway ships is cut to fit.
//
// So the two have to agree, and this is what makes them. The property names
// are the plugin's own (`node_modules/expo-sqlite/plugin/build/withSQLite.js`,
// `updateAndroidBuildPropertyIfNeeded`), and the values it writes are
// `String(value)` — hence the string comparison.
//
// ANDROID ONLY, HERE. `ios/Podfile.properties.json` is the same three keys on
// the iOS side, and it belongs to the macOS CI slice — the lane that can run
// `pod install` and prove the link. This lane owns `apps/mobile/android/**`,
// and asserting a file another branch is writing would fail on this one.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mobileRoot = path.resolve(import.meta.dirname, "../../..");

/** The plugin's Android property names, in the order it writes them. */
const KEYS = ["enableFTS", "useSQLCipher", "withSQLiteVecExtension"] as const;

/** What the plugin block asks for, read out of `app.config.ts` itself. */
function pluginBlockFlags(): Record<string, string> {
  const source = readFileSync(path.join(mobileRoot, "app.config.ts"), "utf8");
  const block = source.slice(
    source.indexOf('"expo-sqlite"'),
    source.indexOf('"expo-video"')
  );
  expect(block, "app.config.ts has no expo-sqlite plugin block").not.toBe("");
  const flags: Record<string, string> = {};
  for (const key of KEYS) {
    const found = new RegExp(`${key}:\\s*(true|false)`, "u").exec(block);
    if (found) flags[key] = found[1]!;
  }
  return flags;
}

/** What the committed Android project will actually be compiled with. */
function gradleFlags(): Record<string, string> {
  const source = readFileSync(
    path.join(mobileRoot, "android/gradle.properties"),
    "utf8"
  );
  const flags: Record<string, string> = {};
  for (const key of KEYS) {
    const found = new RegExp(`^expo\\.sqlite\\.${key}=(.*)$`, "mu").exec(
      source
    );
    if (found) flags[key] = found[1]!.trim();
  }
  return flags;
}

describe("the seat's native SQLite build", () => {
  it("asks for all three flags in the plugin block", () => {
    expect(pluginBlockFlags()).toStrictEqual({
      enableFTS: "true",
      useSQLCipher: "true",
      withSQLiteVecExtension: "true",
    });
  });

  it("carries the same three into the committed Android project", () => {
    expect(gradleFlags()).toStrictEqual(pluginBlockFlags());
  });

  it("names them exactly as the plugin does, so a prebuild would not move them", () => {
    const plugin = readFileSync(
      path.join(
        mobileRoot,
        "../../node_modules/expo-sqlite/plugin/build/withSQLite.js"
      ),
      "utf8"
    );
    for (const key of KEYS) expect(plugin).toContain(`'expo.sqlite.${key}'`);
  });
});
