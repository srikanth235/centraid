// Android build wiring that only the app can decide (#996 CNG wave): the one
// OpenSSL this app links, the Play upload key, and Gradle's build cache.
//
// `android/` is generated, so each of these is written by a mod on every
// `expo prebuild` rather than committed into the tree.
const {
  withAppBuildGradle,
  withGradleProperties,
  withProjectBuildGradle,
} = require("@expo/config-plugins");

// ONE OpenSSL IN THIS APP (#996 wave 3).
//
// Two native modules link OpenSSL from the same Maven artifact at different
// versions: react-native-quick-crypto asks for 3.6.2-1 (streaming SHA-256 for
// camera assets, and the WebCrypto AES-GCM/PBKDF2 Hermes has no provider for),
// and expo-sqlite asks for 3.3.2-1 the moment `expo.sqlite.useSQLCipher` is on
// — SQLCipher IS an OpenSSL consumer (`-DSQLCIPHER_CRYPTO_OPENSSL`). Unforced,
// both land in the build and `:app:mergeReleaseNativeLibs` fails on two
// `libcrypto.so` per ABI.
//
// THE FIX IS ONE LIBRARY, NOT A `pickFirst`. Excluding a duplicate would keep
// two OpenSSL builds in the tree and bind SQLCipher to whichever the merger
// happened to pick; a SQLCipher linked against an OpenSSL it was not compiled
// against is a silent data-corruption path, not a packaging warning. Forcing
// resolves it before anything is packaged, so there is one library and every
// consumer compiled against the headers of the one they get.
//
// NEWEST WINS, and the direction matters: OpenSSL 3.x is ABI-stable within the
// major line, so code compiled against 3.3 headers runs on 3.6, and the reverse
// is not guaranteed. `seat-native-build-config.test.ts` holds the forced version
// equal to the newest any consumer asks for, and fails if a third consumer
// arrives wanting something else.
const OPENSSL_COORDINATE = "io.github.ronickg:openssl:3.6.2-1";

const OPENSSL_BLOCK = `
  // ONE OpenSSL IN THIS APP (#996 wave 3) — written by
  // apps/mobile/plugins/withCentraidAndroidBuild.cjs, which carries the reasoning.
  configurations.all {
    resolutionStrategy {
      force '${OPENSSL_COORDINATE}'
    }
  }
`;

// J1 / #501 — the Play upload key comes from the environment and is never
// committed. Secrets: CENTRAID_UPLOAD_STORE_FILE, CENTRAID_UPLOAD_STORE_PASSWORD,
// CENTRAID_UPLOAD_KEY_ALIAS, CENTRAID_UPLOAD_KEY_PASSWORD.
const RELEASE_SIGNING_CONFIG = `        release {
            def storePath = System.getenv("CENTRAID_UPLOAD_STORE_FILE")
            if (storePath != null && !storePath.isEmpty()) {
                storeFile file(storePath)
                storePassword System.getenv("CENTRAID_UPLOAD_STORE_PASSWORD")
                keyAlias System.getenv("CENTRAID_UPLOAD_KEY_ALIAS")
                keyPassword System.getenv("CENTRAID_UPLOAD_KEY_PASSWORD")
            }
        }
`;

// Opt-in refusal to ship a debug-signed release: set
// CENTRAID_REQUIRE_RELEASE_SIGNING=1 on store lanes only — not plain CI=true,
// because EAS and `assembleDebug` must keep working without the upload keystore.
const RELEASE_SIGNING_SELECTION = `            def uploadStore = System.getenv("CENTRAID_UPLOAD_STORE_FILE")
            def requireRelease = System.getenv("CENTRAID_REQUIRE_RELEASE_SIGNING") == "1"
            if (uploadStore != null && !uploadStore.isEmpty()) {
                signingConfig signingConfigs.release
            } else if (requireRelease) {
                throw new GradleException(
                    "Refusing debug-signed release. Set CENTRAID_UPLOAD_* secrets " +
                    "(Play App Signing upload key — J1) or unset CENTRAID_REQUIRE_RELEASE_SIGNING."
                )
            } else {
                // Local / EAS-managed credentials path — not a store-lane default.
                signingConfig signingConfigs.debug
            }
`;

function replaceOnce(contents, marker, replacement, what) {
  const index = contents.indexOf(marker);
  if (index === -1)
    throw new Error(
      `withCentraidAndroidBuild: could not find ${what} in the generated build.gradle. ` +
        "The Expo template moved; re-derive the anchor rather than skipping the edit."
    );
  if (contents.includes(marker, index + marker.length))
    throw new Error(
      `withCentraidAndroidBuild: ${what} matched more than once; the anchor is no longer unique.`
    );
  return contents.replace(marker, replacement);
}

function withOpenSslResolution(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes(OPENSSL_COORDINATE)) return cfg;
    cfg.modResults.contents = replaceOnce(
      cfg.modResults.contents,
      "    maven { url 'https://www.jitpack.io' }\n  }",
      `    maven { url 'https://www.jitpack.io' }\n  }\n${OPENSSL_BLOCK}`,
      "the allprojects repositories block"
    );
    return cfg;
  });
}

function withUploadSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;

    // The upload signing config, beside the template's debug one.
    contents = replaceOnce(
      contents,
      `            keyPassword 'android'
        }
`,
      `            keyPassword 'android'
        }
${RELEASE_SIGNING_CONFIG}`,
      "the debug signingConfig"
    );

    // Debug and release coexist on one device. Production id stays
    // dev.centraid.mobile; debug becomes dev.centraid.mobile.debug.
    contents = replaceOnce(
      contents,
      `        debug {
            signingConfig signingConfigs.debug
        }
`,
      `        debug {
            signingConfig signingConfigs.debug
            applicationIdSuffix '.debug'
        }
`,
      "the debug buildType"
    );

    contents = replaceOnce(
      contents,
      `            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
`,
      RELEASE_SIGNING_SELECTION,
      "the release buildType signingConfig"
    );

    cfg.modResults.contents = contents;
    return cfg;
  });
}

// GRADLE'S BUILD CACHE, ON (#916).
//
// Without it `~/.gradle/caches` holds dependency modules and artifact
// transforms and no task OUTPUTS, so a runner that has never built this tree
// re-executes every compile even when the sources are byte-identical to a build
// another runner already did. With it, a task whose declared inputs match an
// entry in `~/.gradle/caches/build-cache-1` is unpacked instead of run. That
// directory is inside the path the three Android device lanes already bank
// (`.github/workflows/{ci,candidate,e2e}.yml`, `android-gradle-v2-*`).
//
// It is safe for the store build too, and not fenced behind a CI-only flag: a
// build cache entry is keyed on the hash of the task's declared inputs plus its
// implementation, so a task can only ever be handed an output produced from the
// same inputs by the same code. It is correctness-preserving reuse, not a
// heuristic — the difference between this and caching a directory.
//
// It does not cover AGP's external-native-build (CMake/ninja) tasks, which are
// not cacheable; those stay incremental by keeping their `.cxx` staging
// directories, which the lanes cache alongside this.
//
// `org.gradle.configuration-cache` is DELIBERATELY LEFT UNSET. It caches the
// configuration phase, not compilation, so it does nothing for the native
// compile this exists to remove; Expo SDK 57's gradle plugins do not declare
// configuration-cache compatibility; and `app/build.gradle` shells out with
// `[...].execute()` at configuration time in four places to resolve the React
// Native, Hermes, codegen and Expo CLI paths.
function withBuildCache(config) {
  return withGradleProperties(config, (cfg) => {
    const properties = cfg.modResults.filter(
      (item) => !(item.type === "property" && item.key === "org.gradle.caching")
    );
    properties.push({
      type: "property",
      key: "org.gradle.caching",
      value: "true",
    });
    cfg.modResults = properties;
    return cfg;
  });
}

module.exports = function withCentraidAndroidBuild(config) {
  return withBuildCache(withUploadSigning(withOpenSslResolution(config)));
};
