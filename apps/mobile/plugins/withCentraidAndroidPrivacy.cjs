// Android privacy posture that no upstream plugin expresses (#996 CNG wave).
//
// `ios/` and `android/` are generated, so a hand-edited manifest or a
// hand-written `res/xml` file has nowhere to live. Everything this repo decided
// about Android backup, cleartext and permissions is asserted here instead, and
// `expo prebuild` reapplies it every time.
const fs = require("node:fs");
const path = require("node:path");

const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
} = require("@expo/config-plugins");

const RES_XML = path.join(__dirname, "native", "android", "res", "xml");

// Copied verbatim into `res/xml/`. Each file carries its own rationale; the
// short version is that Centraid opts out of Android backup and device
// transfer entirely (the replica is disposable and re-pairing is the restore
// path), and permits cleartext only for loopback / emulator / `.local`.
const RES_XML_FILES = [
  "network_security_config.xml",
  "replica_backup_rules.xml",
  "replica_data_extraction_rules.xml",
];

// Permissions upstream plugins add that Centraid does not use, removed so the
// Play data-safety form and the runtime prompt list match what the app does.
//
// - RECORD_AUDIO (expo-camera): video capture is silent-video only on Android;
//   the microphone string in `app.config.ts` covers iOS, where AVFoundation
//   demands it for the same capture path.
// - READ_MEDIA_VISUAL_USER_SELECTED (expo-media-library): partial-access photo
//   picking is not a mode Photos offers — the album backup contract needs the
//   full grant or nothing, and a partial grant would silently narrow a backup.
const REMOVED_PERMISSIONS = [
  "android.permission.RECORD_AUDIO",
  "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
];

function withResXmlFiles(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const dir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml"
      );
      fs.mkdirSync(dir, { recursive: true });
      for (const name of RES_XML_FILES)
        fs.copyFileSync(path.join(RES_XML, name), path.join(dir, name));
      return cfg;
    },
  ]);
}

function withCentraidManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const application =
      AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

    // Point the backup attributes at Centraid's rules. expo-secure-store writes
    // `@xml/secure_store_*`, which excludes only its own shared_prefs file;
    // ours exclude every domain, on both the API<=30 and API>=31 paths.
    application.$["android:fullBackupContent"] = "@xml/replica_backup_rules";
    application.$["android:dataExtractionRules"] =
      "@xml/replica_data_extraction_rules";

    // Cleartext is off app-wide (expo-build-properties writes
    // `usesCleartextTraffic="false"`); the network security config is what
    // re-permits it for the loopback / emulator / mDNS hosts a local gateway
    // lives on, and nothing else.
    application.$["android:networkSecurityConfig"] =
      "@xml/network_security_config";

    // expo-media-library sets this so its legacy storage path works on API 29.
    // Centraid's minSdk is above that and every read goes through the scoped
    // MediaStore API, so the opt-out would only widen the app's storage reach.
    delete application.$["android:requestLegacyExternalStorage"];

    manifest.manifest["uses-permission"] = (
      manifest.manifest["uses-permission"] ?? []
    ).filter(
      (permission) =>
        !REMOVED_PERMISSIONS.includes(permission.$["android:name"])
    );

    return cfg;
  });
}

module.exports = function withCentraidAndroidPrivacy(config) {
  return withCentraidManifest(withResXmlFiles(config));
};
