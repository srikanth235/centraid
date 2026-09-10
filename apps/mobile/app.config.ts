import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Single-sources version + native build numbers (#468); app.json cannot drift.
import type { ExpoConfig, ConfigContext } from "expo/config";

// Node require only — extensionless TS fails on CI; import.meta dies under Expo eval.
import { nativeBuildNumber } from "./src/version-core.cjs";

// Version of @centraid/mobile (#501); cwd candidates cover gradle + root.
function readMobilePackageVersion(): string {
  const candidates = [
    path.join(process.cwd(), "package.json"),
    path.join(process.cwd(), "..", "package.json"),
    path.join(process.cwd(), "apps", "mobile", "package.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (j.name === "@centraid/mobile" && typeof j.version === "string")
        return j.version;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "could not resolve @centraid/mobile package.json version for Expo config (issue #501)"
  );
}

const VERSION = readMobilePackageVersion();
const BUILD = nativeBuildNumber(VERSION);
const EAS_PROJECT_ID =
  process.env.EAS_PROJECT_ID?.trim() === ""
    ? undefined
    : process.env.EAS_PROJECT_ID?.trim();

export default function createExpoConfig({
  config,
}: ConfigContext): ExpoConfig {
  return {
    ...config,
    name: "Centraid",

    slug: "centraid",
    version: VERSION,
    orientation: "portrait",
    scheme: "centraid",
    userInterfaceStyle: "automatic",
    icon: "../../assets/icon.png",
    // No top-level `splash`: SDK 57 dropped the key from `ExpoConfig` and the
    // `expo-splash-screen` plugin block below is the whole of it.
    ios: {
      supportsTablet: true,
      bundleIdentifier: "dev.centraid.mobile",
      buildNumber: String(BUILD),
      // The app target's floor. `plugins/withCentraidIos.cjs` re-points the pods
      // and the share extension at this same value.
      deploymentTarget: "17.5",
      // Apple's required-reason API declaration, as config rather than a
      // committed `PrivacyInfo.xcprivacy` — `ios/` is generated (#996 CNG wave).
      // Every reason below is a category Expo's own modules reach: file
      // timestamps (replica + upload staging), UserDefaults (SecureStore,
      // share app group), free disk space (the pre-download space check), and
      // system boot time (queue backoff clocks).
      privacyManifests: {
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType:
              "NSPrivacyAccessedAPICategoryFileTimestamp",
            NSPrivacyAccessedAPITypeReasons: ["C617.1", "0A2A.1", "3B52.1"],
          },
          {
            NSPrivacyAccessedAPIType:
              "NSPrivacyAccessedAPICategoryUserDefaults",
            NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
          },
          {
            NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
            NSPrivacyAccessedAPITypeReasons: ["E174.1", "85F4.1"],
          },
          {
            NSPrivacyAccessedAPIType:
              "NSPrivacyAccessedAPICategorySystemBootTime",
            NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
          },
        ],
        NSPrivacyCollectedDataTypes: [],
        NSPrivacyTracking: false,
      },
      infoPlist: {
        UIBackgroundModes: ["processing", "remote-notification"],
        ITSAppUsesNonExemptEncryption: false,
        NSFaceIDUsageDescription:
          "Centraid uses Face ID to protect the local vault replica and unlock Locker secrets.",
        NSLocalNetworkUsageDescription:
          "Centraid connects to the personal gateway you pair on your local network.",
        NSMicrophoneUsageDescription:
          "Centraid uses the microphone only when you choose to capture a video with sound.",
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: false,
          NSAllowsLocalNetworking: true,
        },
      },
    },
    android: {
      package: "dev.centraid.mobile",
      versionCode: BUILD,
      // Centraid opts out of Android Auto Backup entirely: resume cursors,
      // the cached scope manifest and Keystore-wrapped SecureStore blobs
      // restored onto a phone with an empty replica claim rows that device
      // never had. This key writes `android:allowBackup="false"`; the matching
      // exclusion rules for both backup paths are written by
      // `plugins/withCentraidAndroidPrivacy.cjs`.
      allowBackup: false,
      adaptiveIcon: {
        foregroundImage: "../../assets/adaptive-icon.png",
        backgroundColor: "#3EC8B4",
      },
    },
    // Bare workflow needs a concrete runtime version; VERSION ties OTA to it.
    runtimeVersion: VERSION,
    // Store-only updates (#501): OTA off until a real Expo project id is enrolled.
    updates: EAS_PROJECT_ID
      ? {
          enabled: true,
          checkAutomatically: "ON_ERROR_RECOVERY",
          url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
        }
      : {
          enabled: false,
          checkAutomatically: "NEVER",
        },
    assetBundlePatterns: ["**/*"],
    plugins: [
      // Centraid's own plugins come FIRST on purpose. `@expo/config-plugins`
      // composes mods so that the LAST-registered one runs FIRST
      // (`withMod` calls its own action, then `nextMod`), so a plugin that has
      // to see — and overwrite — what every upstream plugin produced must be
      // registered at the head of this list.
      "./plugins/withCentraidAndroidPrivacy.cjs",
      "./plugins/withCentraidAndroidBuild.cjs",
      "./plugins/withCentraidAndroidSplash.cjs",
      "./plugins/withCentraidIos.cjs",
      "expo-notifications",
      "expo-background-task",
      "expo-secure-store",
      "expo-updates",
      [
        "expo-build-properties",
        {
          ios: { deploymentTarget: "17.5" },
          android: {
            usesCleartextTraffic: false,
          },
        },
      ],
      [
        "expo-media-library",
        {
          photosPermission:
            "Centraid reads your library to show and back up the albums you choose.",
          savePhotosPermission:
            "Centraid saves selected vault photos back to your library.",
          isAccessMediaLocationEnabled: true,
          granularPermissions: ["photo", "video"],
        },
      ],
      [
        "expo-share-intent",
        {
          iosActivationRules: {
            NSExtensionActivationSupportsText: true,
            NSExtensionActivationSupportsWebURLWithMaxCount: 20,
            NSExtensionActivationSupportsImageWithMaxCount: 100,
            NSExtensionActivationSupportsMovieWithMaxCount: 20,
            NSExtensionActivationSupportsFileWithMaxCount: 100,
          },
          androidIntentFilters: ["text/*", "image/*", "video/*", "*/*"],
          androidMultiIntentFilters: ["image/*", "video/*", "*/*"],
          // Kept off the plugin's `${appId}.share-extension` default: the App
          // Store record and its provisioning profile were created against
          // `dev.centraid.mobile.share`, and an extension bundle id is not
          // something a build can rename.
          iosShareExtensionBundleIdentifier: "dev.centraid.mobile.share",
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission:
            "Centraid uses the camera to scan pairing QR codes, documents, cards, and receipts you choose to capture.",
        },
      ],
      // The seat's engine (#996 wave 3). `useSQLCipher` is what makes the
      // phone's SQLite 3.49.1 — `SEAT_SQLITE_FLOOR` — rather than the 3.50.3
      // vendored beside it, and every byte the gateway ships has to clear that
      // floor. `enableFTS` keeps fts5 compiled in: the sanitised snapshot's
      // only surviving triggers are its FTS sync triggers, so a build without
      // fts5 cannot open the file at all.
      //
      // `withSQLiteVecExtension` is now BOTH platforms. 57.0.2 pre-bundles
      // sqlite-vec for Android only — `android/vec/<abi>/vec.so`, no
      // `vec.xcframework` — so iOS builds the framework from the same upstream
      // tag in `scripts/build-sqlite-vec-ios.sh`, which the macOS lock lane and
      // the EAS `eas-build-pre-install` hook run before any pod work. The flag
      // is what makes the podspec vendor it and compile the module with
      // `-DWITH_SQLITE_VEC`; without the framework beside it the flag would
      // point `bundledExtensions["sqlite-vec"]` at a bundle that is not there,
      // which is why the two land together. It is not auto-loaded on either
      // platform — `probeSqliteVec` stays the gate before a vector table is
      // touched.
      [
        "expo-sqlite",
        {
          useSQLCipher: true,
          enableFTS: true,
          withSQLiteVecExtension: true,
        },
      ],
      "expo-video",
      // Photos' map (#816): MapKit iOS + MapLibre/OpenFreeMap Android; NO location permission.
      "expo-maps",
      [
        "@maplibre/maplibre-react-native",
        {
          // Plugin default; `google` would pull Play Services back in.
          android: { locationEngine: "default" },
        },
      ],
      "react-native-quick-crypto",
      // The splash: a flat brand field, no logo. Android draws the launcher
      // icon at 96dp over it because the platform splash API requires an icon;
      // iOS shows the colour alone.
      [
        "expo-splash-screen",
        {
          ios: { backgroundColor: "#3EC8B4" },
          android: { backgroundColor: "#14181F" },
        },
      ],
    ],
    extra: {
      recurrencePolicy: "bounded-local-expansion",
      // For tests/tooling outside Expo's module graph.
      nativeBuildNumber: BUILD,
      updateChannel: EAS_PROJECT_ID ? "eas-hotfix" : "store-only",
      ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
    },
  };
}
