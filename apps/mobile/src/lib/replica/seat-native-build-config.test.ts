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
// BOTH PROJECTS. `android/gradle.properties` and `ios/Podfile.properties.json`
// carry the same three keys, written the two ways the plugin writes them
// (`updateAndroidBuildPropertyIfNeeded` / `updateIOSBuildPropertyIfNeeded`) —
// a gradle `k=v` line and a JSON string. Only the emulator gate's
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

/** What the committed iOS project will actually be compiled with. */
function podfileFlags(): Record<string, string> {
  const properties = JSON.parse(
    readFileSync(path.join(mobileRoot, "ios/Podfile.properties.json"), "utf8")
  ) as Record<string, string>;
  const flags: Record<string, string> = {};
  for (const key of KEYS) {
    const value = properties[`expo.sqlite.${key}`];
    if (value !== undefined) flags[key] = value;
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
    const gradle = readFileSync(
      path.join(mobileRoot, "android/build.gradle"),
      "utf8"
    );
    const forced =
      /force\s+["']io\.github\.ronickg:openssl:(?<version>[\w.-]+)["']/u.exec(
        gradle
      );
    expect(
      forced,
      "apps/mobile/android/build.gradle must force one io.github.ronickg:openssl version"
    ).not.toBeNull();
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
    const gradle = readFileSync(
      path.join(mobileRoot, "android/build.gradle"),
      "utf8"
    );
    const appGradle = readFileSync(
      path.join(mobileRoot, "android/app/build.gradle"),
      "utf8"
    );
    for (const source of [gradle, appGradle])
      expect(source).not.toMatch(/pickFirst\s+["'][^"']*libcrypto\.so["']/u);
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

  it("carries the same three into the committed Android project", () => {
    expect(gradleFlags()).toStrictEqual(pluginBlockFlags());
  });

  it("carries the same three into the committed iOS project", () => {
    expect(podfileFlags()).toStrictEqual(pluginBlockFlags());
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
