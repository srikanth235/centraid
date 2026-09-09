// iOS decisions that no upstream plugin expresses (#996 CNG wave).
//
// `ios/` is generated, so a hand-edited Podfile, entitlements file or share
// extension source has nowhere to live. Each edit below is applied on every
// `expo prebuild` and fails loudly if its anchor moves.
const fs = require("node:fs");
const path = require("node:path");

const {
  withDangerousMod,
  withEntitlementsPlist,
  withMod,
  withXcodeProject,
} = require("@expo/config-plugins");

const NATIVE_IOS = path.join(__dirname, "native", "ios");

// react-native-quick-crypto's own config plugin injects a post_install loop that
// pins EVERY pod to IPHONEOS_DEPLOYMENT_TARGET 16.4 — its literal, not the one
// this app asked for (node_modules/react-native-quick-crypto/src/expo-plugin/
// withXCode.ts). Left alone it silently lowers every pod below the app target's
// 17.5. Rewriting the literal to the Podfile property keeps one source of truth:
// `ios.deploymentTarget` in app.config.ts.
const QUICK_CRYPTO_TARGET_LITERAL =
  "config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.4'";
const DEPLOYMENT_TARGET_FROM_PROPERTIES =
  "config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = podfile_properties['ios.deploymentTarget'] || '16.4'";

function withPodDeploymentTarget(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      const contents = fs.readFileSync(podfile, "utf8");
      if (!contents.includes(QUICK_CRYPTO_TARGET_LITERAL))
        throw new Error(
          "withCentraidIos: react-native-quick-crypto no longer writes its hard-coded " +
            "IPHONEOS_DEPLOYMENT_TARGET line into the Podfile. Re-check whether the pods " +
            "still need pinning before deleting this mod."
        );
      fs.writeFileSync(
        podfile,
        contents.replaceAll(
          QUICK_CRYPTO_TARGET_LITERAL,
          DEPLOYMENT_TARGET_FROM_PROPERTIES
        )
      );
      return cfg;
    },
  ]);
}

// expo-notifications adds `aps-environment` to the app entitlements. Centraid
// introduces no APNs, FCM or push broker (NATIVE_V0.md, "Platform integration")
// — every reminder is scheduled locally — so the app must not claim the push
// capability it would then have to justify at review and provision for.
function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults["aps-environment"];
    return cfg;
  });
}

// expo-share-intent's own ShareViewController delivers attachments as each load
// finishes and stages plaintext copies at the container's default protection
// class. Centraid's replacement awaits every attachment before writing anything
// (#431 F7 — a slow early item was silently dropped when a fast later one
// finished first), stages at `completeUntilFirstUserAuthentication`, and purges
// its own staged copies on every abort path (#880). The file is repo-owned
// source that happens to live inside a generated target, so it is copied over
// the generated one after expo-share-intent has written it.
//
// Registered on `withXcodeProject`, not `withDangerousMod`: expo-share-intent
// writes the extension's sources from its own xcodeproj mod, which runs after
// every dangerous mod. This plugin is listed FIRST in `app.config.ts`, which is
// what makes its mods run LAST (see the note there), so the generated file is
// already on disk when this replaces it.
function withShareViewController(config) {
  return withXcodeProject(config, (cfg) => {
    const destination = path.join(
      cfg.modRequest.platformProjectRoot,
      "ShareExtension",
      "ShareViewController.swift"
    );
    if (!fs.existsSync(destination))
      throw new Error(
        `withCentraidIos: ${destination} is missing — expo-share-intent did not create the ` +
          "share extension, so this replacement would create a file no target compiles."
      );
    fs.copyFileSync(
      path.join(NATIVE_IOS, "ShareViewController.swift"),
      destination
    );
    return cfg;
  });
}

// The launch screen is a flat brand field, no logo.
//
// expo-splash-screen only repaints the storyboard's background when an iOS
// splash IMAGE is configured; with colour alone it leaves the template's
// `systemBackgroundColor`, which follows the system theme and shows white or
// black instead of Centraid teal. The colour asset it writes
// (`Images.xcassets/SplashScreenBackground.colorset`) is correct either way, so
// this only has to point the view at it.
//
// Registered on expo-splash-screen's own `splashScreenStoryboard` mod — the
// storyboard is not a file any base `withDangerousMod` sees at a defined point.
// `modResults` is the xml2js document.
function withSplashBackgroundColor(config) {
  return withMod(config, {
    platform: "ios",
    mod: "splashScreenStoryboard",
    action(cfg) {
      const view =
        cfg.modResults?.document?.scenes?.[0]?.scene?.[0]?.objects?.[0]
          ?.viewController?.[0]?.view?.[0];
      if (!view)
        throw new Error(
          "withCentraidIos: the splash storyboard has no container view; " +
            "expo-splash-screen's template changed shape."
        );
      view.color = [
        { $: { key: "backgroundColor", name: "SplashScreenBackground" } },
      ];
      return cfg;
    },
  });
}

// One deployment floor and one version pair across the whole project.
//
// Two things drift otherwise. `ios.deploymentTarget` only reaches APPLICATION
// targets (expo-build-properties' `updateDeploymentTargetXcodeProject`), so the
// project-level configuration and the share extension keep whatever the
// templates wrote — 16.4 from react-native-quick-crypto's plugin. And Xcode
// templates the extension at MARKETING_VERSION 1.0 / CURRENT_PROJECT_VERSION 1,
// which ships an extension whose version pair disagrees with the app it is
// embedded in; App Store Connect rejects that.
function withProjectWideBuildSettings(config) {
  return withXcodeProject(config, (cfg) => {
    const deploymentTarget = config.ios?.deploymentTarget;
    const version = config.version;
    const buildNumber = config.ios?.buildNumber;
    if (!deploymentTarget || !version || !buildNumber)
      throw new Error(
        "withCentraidIos: app.config.ts must set ios.deploymentTarget, version and " +
          "ios.buildNumber — this mod exists to hold every target to them."
      );

    const configurations = cfg.modResults.pbxXCBuildConfigurationSection();
    let shareExtensionConfigurations = 0;

    for (const key of Object.keys(configurations)) {
      const settings = configurations[key]?.buildSettings;
      if (!settings) continue;

      settings.IPHONEOS_DEPLOYMENT_TARGET = deploymentTarget;

      // pbxproj values arrive quoted; compare on the unquoted form.
      const bundleId =
        typeof settings.PRODUCT_BUNDLE_IDENTIFIER === "string"
          ? settings.PRODUCT_BUNDLE_IDENTIFIER.replace(/"/gu, "")
          : undefined;
      if (bundleId === undefined) continue;
      if (bundleId.endsWith(".share")) shareExtensionConfigurations += 1;
      settings.MARKETING_VERSION = `"${version}"`;
      settings.CURRENT_PROJECT_VERSION = `"${buildNumber}"`;
    }

    if (shareExtensionConfigurations === 0)
      throw new Error(
        "withCentraidIos: no build configuration carries the share extension bundle " +
          "identifier. Check `iosShareExtensionBundleIdentifier` in the expo-share-intent " +
          "plugin options before dropping this mod."
      );

    return cfg;
  });
}

module.exports = function withCentraidIos(config) {
  return withProjectWideBuildSettings(
    withShareViewController(
      withSplashBackgroundColor(
        withoutPushEntitlement(withPodDeploymentTarget(config))
      )
    )
  );
};
