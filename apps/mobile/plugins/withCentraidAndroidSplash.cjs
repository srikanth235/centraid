// The Android splash icon (#996 CNG wave).
//
// `expo-splash-screen` writes `Theme.App.SplashScreen` with
// `windowSplashScreenAnimatedIcon = @drawable/splashscreen_logo` whether or not
// an image was configured, and only creates that drawable when one was. Centraid
// wants the launcher icon on a flat field rather than a second piece of art, so
// the drawable is supplied here — without it AAPT fails on a missing resource.
//
// It cannot be expressed as `android.image` in the plugin options: pointing that
// at the icon asset also makes expo-splash-screen rewrite
// `drawable/ic_launcher_background.xml` (the file it uses for the splash layer,
// despite the name) with the image bitmap layered in, which is the same drawable
// the ADAPTIVE ICON's background references — the icon would then carry the
// splash art.
const fs = require("node:fs");
const path = require("node:path");

const { withDangerousMod } = require("@expo/config-plugins");

const DRAWABLE = path.join(__dirname, "native", "android", "res", "drawable");

module.exports = function withCentraidAndroidSplash(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const dir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "drawable"
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(
        path.join(DRAWABLE, "splashscreen_logo.xml"),
        path.join(dir, "splashscreen_logo.xml")
      );
      return cfg;
    },
  ]);
};
