#!/usr/bin/env bash
# Shared preamble for every iOS device lane — the simulator twin of
# android-emulator-install.sh (#915 Wave 2). SOURCED (not executed) by:
#
#   ios-simulator-smoke.sh   candidate.yml `mobile-ios-smoke`, rung 3
#
# and intended for `e2e.yml`'s `mobile-e2e-ios` (rung 4) once the MOBILE-WIRE
# slice swaps that job's inline steps to it.
#
# WHAT THIS CHANGES, AND WHY THE CACHE KEY GETS SHORTER. The iOS `.app` has been
# cached since #890, keyed `xc<toolchain>-fp<native>-js<bundle>`. The `js`
# component is there because `expo run:ios --configuration Release` EMBEDS the
# Hermes bundle in the product, so a JS-only commit produced a different `.app`
# and had to rebuild it — ~32 minutes of a 51-minute job, on a macOS runner,
# for a change that touched no native code. Android has not paid that since
# #905: it re-installs the banked apk and re-stamps its JS, which is the
# "pay packaging, not compilation" path. This script is that path for iOS.
#
# The key becomes `ios-shell-${{ runner.os }}-xc<toolchain>-fp<native>` — no
# `js` — and the JS is made current here instead:
#
#   BUILD    no banked shell for this native fingerprint -> `expo run:ios
#            --configuration Release`, then bank the `.app`, the `hermesc` that
#            built it, and a `js-bundle.hash` stamp.
#   INJECT   banked shell, different JS -> re-export this SHA's bundle into the
#            banked `.app`, re-stamp, install.
#   INSTALL  banked shell already carrying this SHA's JS -> install as-is.
#
# The branch itself is `ios-shell-cache.mjs`, so it has a unit suite: a wrong
# BUILD is a slow lane, but a wrong INSTALL is a GREEN lane that drove another
# commit's JavaScript, and that failure is silent by construction.
#
# HOW THE INJECTION IS THE SAME BUNDLE THE BUILD WOULD HAVE MADE. Not by
# resemblance — by running the same two commands the Xcode build phase runs.
# `ios/Centraid.xcodeproj`'s "Bundle React Native code and images" phase sets
# `BUNDLE_COMMAND=export:embed` and execs `react-native-xcode.sh`, which:
#
#   1. runs `<expo cli> export:embed --entry-file … --platform ios --dev false
#      --reset-cache --bundle-output <tmp> --assets-dest <app> --minify false`
#      (`--minify false` because "Hermes doesn't require JS minification"), and
#   2. runs `hermesc -emit-binary -max-diagnostic-width=80 -O -out
#      <app>/main.jsbundle <tmp>`.
#
# Step 2 is not optional and is the trap this script exists to document:
# `expo export:embed` deliberately writes PLAIN JAVASCRIPT — @expo/cli's
# `exportEmbedAsync.js` sets `bytecode: false` with the comment "Never output
# bytecode in the exported bundle since that is hardcoded in the native run
# script". Injecting its output directly would leave a Hermes app running a
# source bundle: it launches, so nothing goes red, and every `cold-start` and
# `scroll-frames` number afterwards describes an engine path no member has.
# See docs/traps/ios-shell-injection.md.
#
# `hermesc` lives at `ios/Pods/hermes-engine/destroot/bin/hermesc`, and Pods are
# deliberately NOT cached (see e2e.yml's note: a Pods cache hit makes Expo skip
# `pod install`, which is the only thing that runs the centraid-tunnel
# podspec's prepare_command). So the cold path banks `hermesc` beside the `.app`
# under the same content-addressed key. That is sound because the key carries
# the native fingerprint, and `hermes-engine`'s version is a Podfile.lock input
# to it: a banked hermesc is always the one that built the banked shell.
#
# WHAT LOADS THE INJECTED BUNDLE, verified rather than assumed:
# `ios/Centraid/AppDelegate.swift`'s `bundleURL()` returns
# `Bundle.main.url(forResource: "main", withExtension: "jsbundle")` in a
# non-debug build — i.e. `<Centraid.app>/main.jsbundle`, exactly the path
# `react-native-xcode.sh` writes to (`$DEST/$BUNDLE_NAME.jsbundle`, `DEST` being
# the app's resources folder). NO RE-SIGNING is needed: a simulator build is not
# code-signed, which is why `xcrun simctl install` accepts a modified bundle.
#
# Contract for every caller:
#   - CWD is the repo root.
#   - IOS_CACHE_HIT is "true" when the fingerprinted shell cache was restored.
#   - SIMULATOR_UDID names a booted simulator.
#   - GITHUB_OUTPUT receives `built=true` only when this run actually compiled a
#     fresh shell, so the cache-save step knows there is something new to bank.
set -euo pipefail

cache_dir="$HOME/.cache/centraid-mobile-e2e"
app="$cache_dir/Centraid.app"
js_stamp="$cache_dir/js-bundle.hash"
hermesc="$cache_dir/hermesc"
expected_bundle_id="dev.centraid.mobile"

js_bundle_hash="$(node apps/mobile/scripts/js-bundle-fingerprint.mjs)"
test -n "$js_bundle_hash" || {
  echo "::error::empty JS bundle fingerprint; refusing to install an unverifiable app"
  exit 1
}

# The branch, decided by the module that has a unit suite rather than by a bash
# condition nothing can reach. `--json` so the reason travels with the verdict:
# a lane that rebuilt is a lane that spent thirty minutes, and the log should
# say which of the three reasons bought them.
decision_json="$(node -e '
  const { decideShellPath } = await import("./apps/mobile/scripts/ios-shell-cache.mjs");
  const { existsSync, readFileSync } = await import("node:fs");
  const dir = process.argv[1];
  const stamp = `${dir}/js-bundle.hash`;
  process.stdout.write(
    JSON.stringify(
      decideShellPath({
        cacheHit: process.env.IOS_CACHE_HIT === "true",
        appPresent: existsSync(`${dir}/Centraid.app`),
        bankedJs: existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : undefined,
        currentJs: process.argv[2],
        hermescPresent: existsSync(`${dir}/hermesc`),
      })
    )
  );
' --input-type=module "$cache_dir" "$js_bundle_hash")"
decision="$(printf '%s' "$decision_json" | node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0,"utf8")).path)')"
why="$(printf '%s' "$decision_json" | node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0,"utf8")).why)')"
echo "iOS shell: $decision — $why"

case "$decision" in
  build)
    # #890 W1 — the perf-flavored release. The frame sampler exists only when
    # this flag is inlined at export time, so `scroll-frames` and `cold-start`
    # measure the artifact rather than a dev build. It has to be on THIS
    # process, because Metro inlines EXPO_PUBLIC_* when the bundle is exported.
    (
      cd apps/mobile
      EXPO_PUBLIC_CENTRAID_FRAME_PROBE=1 bunx expo run:ios \
        --configuration Release --device "$SIMULATOR_UDID" --no-bundler
    )
    built="$(find apps/mobile/ios/build "$HOME/Library/Developer/Xcode/DerivedData" \
      -maxdepth 8 -type d -name 'Centraid.app' -path '*-iphonesimulator*' -print -quit 2>/dev/null || true)"
    test -n "$built" || { echo "::error::built Centraid.app not found"; exit 1; }
    rm -rf "$cache_dir"
    mkdir -p "$cache_dir"
    # -R preserves the bundle's symlinks and permissions.
    cp -R "$built" "$app"
    # Bank the compiler beside the product it compiled — see the header for why
    # Pods cannot be cached and why this key is the right one to bank it under.
    built_hermesc="apps/mobile/ios/Pods/hermes-engine/destroot/bin/hermesc"
    test -x "$built_hermesc" || {
      echo "::error::no hermesc at $built_hermesc after a Release build; the injection path would be unreachable on every later run"
      exit 1
    }
    cp "$built_hermesc" "$hermesc"
    printf '%s' "$js_bundle_hash" > "$js_stamp"
    echo 'built=true' >> "$GITHUB_OUTPUT"
    ;;
  inject)
    # THE SAME TWO COMMANDS THE XCODE BUILD PHASE RUNS. See the header.
    entry="$(node -e "require('expo/scripts/resolveAppEntry')" apps/mobile ios absolute | tail -n 1)"
    test -n "$entry" || { echo "::error::could not resolve the app entry file"; exit 1; }
    tmp_bundle="$(mktemp -t centraid-main-jsbundle)"
    # The previous commit's RN assets are removed first: `--assets-dest` adds and
    # overwrites but never deletes, so without this the shell accumulates every
    # asset every commit it has ever carried, and a removed image would still be
    # in the app that is supposed to be this SHA's.
    rm -rf "$app/assets"
    (
      cd apps/mobile
      EXPO_PUBLIC_CENTRAID_FRAME_PROBE=1 NODE_ENV=production bunx expo export:embed \
        --entry-file "$entry" \
        --platform ios \
        --dev false \
        --reset-cache \
        --minify false \
        --bundle-output "$tmp_bundle" \
        --assets-dest "$app"
    )
    test -s "$tmp_bundle" || { echo "::error::expo export:embed produced no bundle"; exit 1; }
    "$hermesc" -emit-binary -max-diagnostic-width=80 -O -out "$app/main.jsbundle" "$tmp_bundle"
    rm -f "$tmp_bundle"
    # PROVE IT IS BYTECODE. A Hermes bytecode file begins with the magic
    # 0xC61FBC03. If the compile silently produced source, the app would still
    # launch and every performance number afterwards would describe an engine
    # path no member has — the exact failure this whole step exists to avoid, and
    # the one that is invisible without this assertion.
    head -c 4 "$app/main.jsbundle" | xxd -p | grep -qi '^c61fbc03$' || {
      echo "::error::$app/main.jsbundle is not Hermes bytecode after hermesc; refusing to drive a source bundle on a Release lane"
      exit 1
    }
    printf '%s' "$js_bundle_hash" > "$js_stamp"
    ;;
  install)
    : # nothing to do; the banked shell is already this commit's
    ;;
  *)
    echo "::error::unrecognised shell path '$decision'"
    exit 1
    ;;
esac

# Prove the bundle the flows will drive is the one the harness launches. The
# Maestro harness launches by bundle id, so a mismatch here would fail obscurely
# at flow time instead of loudly right now — the same assertion the Android
# preamble makes with `pm list packages`.
test -d "$app" || { echo "::error::no Centraid.app at $app"; exit 1; }
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
test "$bundle_id" = "$expected_bundle_id" || {
  echo "::error::app bundle id is '$bundle_id', expected $expected_bundle_id"
  exit 1
}
test -x "$app/Centraid" || { echo "::error::app has no executable"; exit 1; }
test -s "$app/main.jsbundle" || {
  echo "::error::app carries no main.jsbundle; AppDelegate.bundleURL() would return nil and the app would launch to a blank screen"
  exit 1
}
banked="$(cat "$js_stamp" 2>/dev/null || true)"
test "$banked" = "$js_bundle_hash" || {
  echo "::error::the installed app carries JS bundle '${banked:-<unstamped>}' but this commit is '$js_bundle_hash'."
  echo "::error::driving it would test another commit's JavaScript and report green."
  exit 1
}

xcrun simctl install "$SIMULATOR_UDID" "$app"
xcrun simctl get_app_container "$SIMULATOR_UDID" "$expected_bundle_id" > /dev/null

node scripts/test-report/prepare.mjs

# #905 — THE CORPUS GOES IN BEFORE ANYTHING PAIRS. A lane is many flows sharing
# ONE pairing, and a flow's own `ctx.ensureDemo` writes to the gateway only, so
# every seed after that first pairing is invisible to the phone: Home sees every
# tile settled and empty, renders `DayOne` instead of `LauncherGrid`, and every
# journey fails at its first `Open <App>` tap while the app is behaving
# correctly. That is #870, and it is the same defect on either platform, so the
# same seeding sits at the same place in both preambles. `scripts/lint-e2e-wiring.mjs`
# RULE corpus enforces the ordering on the Android preamble; this one mirrors it.
node tests/agent-e2e-mobile/seed-demo-corpus.mjs

export MAESTRO_PLATFORM=ios
# Read by lib/harness.mjs: on `release` it skips the Metro reachability wait and
# the bundle prewarm entirely — a release artifact carries its own bundle and
# never talks to Metro.
export CENTRAID_MOBILE_BUILD="${CENTRAID_MOBILE_BUILD:-release}"
