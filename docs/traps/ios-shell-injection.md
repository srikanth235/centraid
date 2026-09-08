# `expo export:embed` writes plain JavaScript, and a Hermes app will run it

**Area:** `apps/mobile/scripts/ios-simulator-install.sh`, the iOS shell cache, any change that re-uses a built `.app` across commits.

## The trap

The iOS device lanes cache the built simulator `.app` and, since [#915](https://github.com/srikanth235/centraid/issues/915) Wave 2, key that cache on the **native** fingerprint alone. A commit that touches only JavaScript therefore restores another commit's shell, and the lane makes it current by re-exporting this SHA's bundle into it — the "pay packaging, not compilation" path `android-emulator-install.sh` has used since [#905](https://github.com/srikanth235/centraid/issues/905).

The obvious way to do that is wrong in a way nothing goes red about:

```sh
# WRONG — writes SOURCE into a Hermes app
bunx expo export:embed --platform ios --dev false \
  --bundle-output "$app/main.jsbundle" --assets-dest "$app"
```

`@expo/cli`'s `exportEmbedAsync.js` sets `bytecode: false` with the comment _"Never output bytecode in the exported bundle since that is hardcoded in the native run script"_. So `export:embed` emits plain JavaScript, by design. The Xcode build phase that normally calls it — `ios/Centraid.xcodeproj`'s "Bundle React Native code and images", which sets `BUNDLE_COMMAND=export:embed` and execs `react-native/scripts/react-native-xcode.sh` — runs a **second** command afterwards:

```sh
"$HERMES_CLI_PATH" -emit-binary -max-diagnostic-width=80 -O \
  -out "$DEST/main.jsbundle" "$BUNDLE_FILE"
```

Skip it and Hermes still runs the app: it compiles the source lazily at launch. Nothing throws, no assertion fails, the lane goes green. What changed is the engine path — and this lane exists to measure exactly that. `cold-start` and `scroll-frames` are here because [#890](https://github.com/srikanth235/centraid/issues/890) W1 moved them off the dev client so they would stop describing a build nobody installs; a source bundle puts them back to describing a build nobody installs, with no dev client to make it obvious.

## Two consequences that are easy to miss

- **`hermesc` is not in the cache by default.** It lives at `ios/Pods/hermes-engine/destroot/bin/hermesc`, and Pods are deliberately **not** cached (a Pods cache hit makes Expo skip `pod install`, which is the only thing that runs the `centraid-tunnel` podspec's `prepare_command` — see the note in `e2e.yml`). So the cold path banks `hermesc` **beside** the `.app`, under the same content-addressed key. That is sound because the key carries the native fingerprint and `hermes-engine`'s version is a `Podfile.lock` input to it: a banked `hermesc` is always the one that built the banked shell. A shell banked before this path existed has no `hermesc`, and `ios-shell-cache.mjs` rebuilds rather than injecting.
- **`--assets-dest` adds and overwrites; it never deletes.** Without `rm -rf "$app/assets"` first, the shell accumulates every asset of every commit it has ever carried, and an image deleted in this commit is still in the app that claims to be this commit's.

## How to know it worked

`ios-simulator-install.sh` asserts it rather than trusting it: a Hermes bytecode file begins with the magic `0xC61FBC03`, so the script reads the first four bytes of the injected `main.jsbundle` and fails the lane if they are anything else. The other half — that the app loads _that_ file — is `ios/Centraid/AppDelegate.swift`'s `bundleURL()`, which returns `Bundle.main.url(forResource: "main", withExtension: "jsbundle")` on a non-debug build: `<Centraid.app>/main.jsbundle`, the same path `react-native-xcode.sh` writes to. No re-signing is involved because a simulator build is not code-signed, which is why `xcrun simctl install` accepts a modified bundle at all.

## The rule

Whenever you re-use a built `.app` across commits, run **both** commands the Xcode phase runs, in order, and assert the magic. Copying only the first is the failure that reports green.
