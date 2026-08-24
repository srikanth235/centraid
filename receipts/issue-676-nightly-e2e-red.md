# Issue #676 — [nightly] e2e lane red — tracking

The scheduled `e2e` workflow had been red every night since 2026-08-10. This
receipt covers the 2026-08-24 repair wave: three lanes, three independent
causes, each reproduced from the run logs before being changed.

## Checklist

- [x] mobile-e2e-ios red with `'MapLibre/MapLibre.h' file not found` and xcodebuild exit 65
- [x] mobile-e2e-android red at `"Connect your gateway." is visible`
- [x] web-e2e-cross-browser red on the missing `chrome-headless-shell` executable
- [ ] pairing-lifecycle / pairing-ticket-hygiene / restore-year3 / quality-performance-scale — fixed in #852, recorded here only for the delta
- [ ] next scheduled run green end-to-end

## What changed

### mobile-e2e-ios — the MapLibre native SDK was never attached

mobile-e2e-ios red with `'MapLibre/MapLibre.h' file not found` and xcodebuild exit 65 on every scheduled run since the pod landed. Red since `2031b8dd` (#816) added `@maplibre/maplibre-react-native`. The pod's
own sources install fine (`Installing MapLibreReactNative (11.3.6)` in every
failing run), but its native engine ships through **Swift Package Manager**,
not CocoaPods: the podspec compiles only the RN bridge and expects the app's
Podfile `post_install` to call `$MLRN.post_install(installer)`, which attaches
the `MapLibre` product (`maplibre-gl-native-distribution`, exact 6.26.0) to
both the Pods project and the app target as an SPM package reference. No
Podfile in this repo ever called it, so every build died with walls of
`'MapLibre/MapLibre.h' file not found` → xcodebuild exit 65. The committed
`apps/mobile/ios/Podfile.lock` did not even contain `MapLibreReactNative` —
#817's receipt handed native regeneration to "a macOS host" and the hand-off
was never completed.

`apps/mobile/ios/Podfile` now calls `$MLRN.post_install(installer)` (with a
comment explaining why it must not be skipped), and `pod install` was run on
a macOS host: `apps/mobile/ios/Podfile.lock` records
`MapLibreReactNative (11.3.6)` and
`apps/mobile/ios/Centraid.xcodeproj/project.pbxproj` carries the
`XCRemoteSwiftPackageReference "maplibre-gl-native-distribution"`. The same
re-resolution also settled unrelated drift the lock had been carrying —
`react-native-maps` entries dropped (removed JS-side by #817),
`ExpoMaps (57.0.1)` gained, `ExpoLinking` 57.0.5→57.0.4 and `NitroModules`
0.36.5→0.36.1 pinned to what current `node_modules` actually ships.

### mobile flows — the dev client lost its URL

mobile-e2e-android red at `"Connect your gateway." is visible`, every night; iOS died at the same launcher before it reached its headers. Red since `expo-dev-client` shipped (#723). A Maestro `launchApp` with
`clearState: true` wipes the launcher's stored "last opened" Metro URL along
with app state, so the relaunch sits on the launcher's empty server picker
forever — discovery never lists this repo's Metro from a CI emulator or
simulator — and every assertion times out against copy that is entirely
correct. Android's `"Connect your gateway." is visible` failure was the
visible tip.

Every cleared-state launch now opens `DEV_LAUNCHER_LINK`
(`tests/agent-e2e-mobile/lib/metro.mjs`), the app's own `centraid://` scheme
carrying the explicit bundle URL; plain relaunches auto-resume and need
nothing. `CONFIRM_SYSTEM_OPEN` (`tests/agent-e2e-mobile/lib/harness.mjs`)
absorbs iOS Simulator's system `Open in "Centraid"?` sheet that `simctl
openurl` raises a moment after the openLink returns (`optional: true`,
anchored `^Open$`; Android fires the VIEW intent directly and takes the
no-dialog path). Applied in the shared `runFlow` config and to
`tests/agent-e2e-mobile/flows/home-loads.mjs`,
`tests/agent-e2e-mobile/flows/photos-permissions.mjs`, and
`tests/agent-e2e-mobile/flows/scroll-frames.mjs`;
`tests/agent-e2e-mobile/README.md` documents the invariant.

### web-e2e-cross-browser — chromium was never installed

web-e2e-cross-browser red on the missing `chrome-headless-shell` executable, every spec failing in milliseconds. Every spec failed in ~2ms with `browserType.launch: Executable doesn't exist
at …/chromium_headless_shell-*/chrome-headless-shell`. The cross-browser
matrix widens the default Chromium set with webkit/firefox
(`apps/web/tests/e2e/playwright.config.ts`, #842 W5.1), but `.github/workflows/e2e.yml`
installed only `webkit firefox`. Playwright ≥1.49 runs headless Chromium
through a separate `chrome-headless-shell` binary that those two downloads do
not pull in, so the job's own base engine was missing. The job now installs
`chromium webkit firefox`, and the config comment that named the old install
line was updated to match.

## Decisions

- The Podfile hook is called **unguarded** (`$MLRN.post_install(installer)`,
  no defined-nil check): if the map package is ever removed, removing this
  hook in the same change is correct, and a loud NoMethodError beats silently
  re-entering the failure mode this fixes.
- The iOS fix lands without a local simulator build; verification delegates to
  the dispatched nightly lane (see Verification), because a local xcodebuild
  would re-measure what the SPM wiring already proves structurally: the
  package reference is in the committed project and pod install resolves.

## Out of scope

- The pairing/scale rows above (fixed in #852) get no code here.
- No new mobile journeys: the three existing cleared-state flows are the
  measurement surface for the launcher fix.

## Verification

Pod install on a macOS host resolves the SPM reference and regenerates the
lock with the bridge pod:

```
cd apps/mobile/ios && pod install
# …
grep -n "MapLibreReactNative (11.3.6)" Podfile.lock
# 349:  - MapLibreReactNative (11.3.6):
grep -c "maplibre-gl-native-distribution" Centraid.xcodeproj/project.pbxproj
# 4
```

The remaining claims are delegated to the e2e lanes themselves, dispatched via
`gh workflow run e2e --ref main -f suite=all`: `mobile-e2e-ios` is expected to
build past the former `'MapLibre/MapLibre.h'` wall and drive the flows;
`mobile-e2e-android` to reach `"Connect your gateway."` after the launcher
hand-off; `web-e2e-cross-browser` to launch its chromium project. None of
these has run yet at the time of writing — the checklist row above stays
unchecked until the dispatch returns.

## Audit

**Verdict: PASS**

The audit read the full `git diff a3c11db06` (eleven files plus the receipt: Podfile,
Podfile.lock, project.pbxproj, e2e.yml, apps/web playwright.config.ts, and the five
tests/agent-e2e-mobile files) against the three claims and issue #676. All three
claims correspond to real code: the `$MLRN.post_install(installer)` hook with its
pbxproj `XCRemoteSwiftPackageReference "maplibre-gl-native-distribution"` (exact
6.26.0) and `MapLibre` product dependency, whose lock/pbxproj greps reproduce the
receipt's recorded output exactly (line 349; count 4); the `DEV_LAUNCHER_LINK` +
`CONFIRM_SYSTEM_OPEN` wiring across the runFlow template, all three flows, and the
README; and the `chromium webkit firefox` install with its matching config comment.
Issue correspondence held: mobile lanes red every scheduled night through 2026-08-23,
and #816's 08-17 landing places the MapLibre header wall after the earlier
compatibility-wall triage. One correction was noted for the author: Podfile.lock also
removes react-native-maps, adds ExpoMaps, and downgrades ExpoLinking/NitroModules —
collateral re-resolution the receipt should mention in one line. That line was added.
End-to-end lane verification remains correctly delegated to the dispatched nightly,
which the checklist still marks unmeasured. Verdict: PASS.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-24 | opencode | - |
