import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Expo config — single-sources version + native build numbers (#468).
 * Build numbers come from {@link nativeBuildNumber} so app.json hardcodes cannot drift.
 */
import type { ExpoConfig, ConfigContext } from "expo/config";

// Expo evaluates app.config via Node CJS resolve (require-from-string). An
// extensionless TS import of `./src/version-core` fails with MODULE_NOT_FOUND
// on CI; the .cjs twin is the same formula and resolves under plain require.
// Do NOT use import.meta.url / fileURLToPath here — Expo's eval path mixes
// CJS `exports` with ESM load and dies with "exports is not defined".
import { nativeBuildNumber } from "./src/version-core.cjs";

/**
 * Single-source version from `@centraid/mobile` package.json (synced from the
 * monorepo root by scripts/release/sync-versions.mjs / publish.mjs — #501).
 * Walk cwd candidates so gradle (cwd=android/) and monorepo-root invokers both
 * resolve the right package.json without import.meta.
 */
function readMobilePackageVersion(): string {
  const candidates = [
    path.join(process.cwd(), "package.json"),
    path.join(process.cwd(), "..", "package.json"), // apps/mobile/android → apps/mobile
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
    splash: {
      image: "../../assets/splash.png",
      backgroundColor: "#3EC8B4",
      resizeMode: "contain",
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: "dev.centraid.mobile",
      buildNumber: String(BUILD),
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
      adaptiveIcon: {
        foregroundImage: "../../assets/adaptive-icon.png",
        backgroundColor: "#3EC8B4",
      },
    },
    // The native projects are checked in (bare workflow), where Expo
    // requires a concrete runtime version rather than the managed-workflow
    // `appVersion` policy. VERSION is the same value that policy would
    // resolve to and keeps OTA compatibility tied to the store version.
    runtimeVersion: VERSION,
    // Routine updates are store-only (#501). The emergency OTA lane is
    // explicitly disabled until the real Expo project id is enrolled; no
    // placeholder endpoint or dormant native updater ships.
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
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission:
            "Centraid uses the camera to scan pairing QR codes, documents, cards, and receipts you choose to capture.",
        },
      ],
      "expo-video",
      // Photos' real map (#816). MapKit on iOS through `expo-maps`, MapLibre
      // over OpenFreeMap's vector tiles on Android — the split exists because
      // `expo-maps`' Android side is Google Maps, which would mean an API key
      // and Play Services. Neither plugin is given `requestLocationPermission`:
      // this map answers "where have I been", never "where am I", so the app
      // asks for no location grant to draw it.
      "expo-maps",
      [
        "@maplibre/maplibre-react-native",
        {
          // The plugin's own default, stated rather than inherited: `google`
          // would pull Play Services back in through the location engine and
          // undo the reason MapLibre is here at all.
          android: { locationEngine: "default" },
        },
      ],
      "react-native-quick-crypto",
      "./plugins/withCentraidUploadService.cjs",
    ],
    extra: {
      recurrencePolicy: "bounded-local-expansion",
      // Expose for tests / tooling that cannot import version-core through Expo.
      nativeBuildNumber: BUILD,
      updateChannel: EAS_PROJECT_ID ? "eas-hotfix" : "store-only",
      ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
    },
  };
}
