// THE FLAGS HAVE TO REACH THE BUILD.
//
// `android/` and `ios/` are generated (#996 CNG wave): `expo prebuild` writes
// `android/gradle.properties` and `ios/Podfile.properties.json` from the
// expo-sqlite plugin block in `app.config.ts`, so the block IS the build. What
// still has to be held is that the block asks for all three flags, and that it
// names them the way the plugin reads them — a renamed key would write nothing
// and Android would silently ship the vendored 3.50.3 with no SQLCipher and no
// fts5, and the phone would stop being the 3.49.1 seat every byte the gateway
// ships is cut to fit.
//
// The property names are the plugin's own
// (`node_modules/expo-sqlite/plugin/build/withSQLite.js`,
// `updateAndroidBuildPropertyIfNeeded`). Only the emulator gate's
// `assembleRelease` and a macOS `pod install` prove they LINK; what this holds
// is that they are asked for at all.
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Every native module that brings its own OpenSSL into the Android build, and
 * which version it asks for.
 *
 * SQLCipher IS an OpenSSL consumer — `-DSQLCIPHER_CRYPTO_OPENSSL` — so turning
 * `useSQLCipher` on made expo-sqlite the SECOND module in this app asking for
 * `io.github.ronickg:openssl`; react-native-quick-crypto was already the
 * first. Two versions of one artifact put two copies of `libcrypto.so`, one
 * per ABI directory, into `:app:mergeReleaseNativeLibs`, and the Android build
 * dies there.
 */
function opensslConsumers(): { module: string; version: string }[] {
  const modulesRoot = path.resolve(mobileRoot, "../../node_modules");
  const found: { module: string; version: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const child = path.join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        walk(child, depth + 1);
        continue;
      }
      const gradle = path.join(child, "android/build.gradle");
      if (!existsSync(gradle)) continue;
      for (const match of readFileSync(gradle, "utf8").matchAll(
        /io\.github\.ronickg:openssl:(?<version>[\w.-]+)/gu
      ))
        found.push({ module: entry.name, version: match.groups!.version! });
    }
  };
  walk(modulesRoot, 0);
  return found;
}

describe("one OpenSSL in the Android build", () => {
  it("still has more than one module asking for it, so the force is load-bearing", () => {
    // If this ever drops to one consumer the force below is dead weight and
    // should go — the test says so rather than leaving it to rot.
    const consumers = opensslConsumers();
    expect(consumers.length).toBeGreaterThan(1);
    expect(consumers.map((c) => c.module)).toContain("expo-sqlite");
    expect(consumers.map((c) => c.module)).toContain(
      "react-native-quick-crypto"
    );
  });

  it("pins every consumer to one version in the app's own build.gradle", () => {
    // NOT `pickFirst` on libcrypto.so: that keeps two builds and picks one
    // arbitrarily, and a SQLCipher linked against an OpenSSL it was not
    // compiled for is a silent data-corruption path, not a packaging warning.
    // One artifact, one version, resolved before anything is packaged.
    const versions = [
      ...new Set(opensslConsumers().map((consumer) => consumer.version)),
    ];
    const plugin = readFileSync(
      path.join(mobileRoot, "plugins/withCentraidAndroidBuild.cjs"),
      "utf8"
    );
    // The plugin declares the coordinate once and interpolates it into both the
    // Gradle block it writes and the guard that skips a second write, so the
    // constant is the single place a version can be stated.
    const forced =
      /OPENSSL_COORDINATE =\s*"io\.github\.ronickg:openssl:(?<version>[\w.-]+)"/u.exec(
        plugin
      );
    expect(
      forced,
      "withCentraidAndroidBuild.cjs must force one io.github.ronickg:openssl version"
    ).not.toBeNull();
    expect(
      plugin,
      "the forced coordinate must reach the Gradle block by interpolation"
    ).toContain(`force '\${OPENSSL_COORDINATE}'`);
    // The forced version must be one a consumer actually asks for, and the
    // NEWEST of them: OpenSSL 3.x is ABI-stable within the major line, so
    // linking the older headers against the newer library is the safe
    // direction and the reverse is not.
    const newest = [...versions].sort().at(-1);
    expect(forced?.groups?.version).toBe(newest);
  });

  it("refuses a `pickFirst` on libcrypto as the answer", () => {
    // The symptom fix. It would make the build green and leave two OpenSSLs in
    // the tree with SQLCipher bound to whichever the merger happened to pick.
    // Both plugins that can reach a Gradle file are checked, so the symptom fix
    // cannot be smuggled in beside the real one.
    for (const file of [
      "plugins/withCentraidAndroidBuild.cjs",
      "app.config.ts",
    ])
      expect(readFileSync(path.join(mobileRoot, file), "utf8")).not.toMatch(
        /pickFirst\s+["'][^"']*libcrypto\.so["']/u
      );
  });
});

describe("the seat's native SQLite build", () => {
  it("asks for all three flags in the plugin block", () => {
    expect(pluginBlockFlags()).toStrictEqual({
      enableFTS: "true",
      useSQLCipher: "true",
      withSQLiteVecExtension: "true",
    });
  });

  it("names them exactly as the plugin reads them, so the prebuild writes them", () => {
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
