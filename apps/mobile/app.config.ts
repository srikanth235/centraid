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
      "./plugins/withCentraidUploadService.cjs",
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
