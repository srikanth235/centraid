# Agent-driven exploratory QA — mobile

This is the committed manual-QA adapter for the Expo app on an iOS Simulator or Android emulator. Desktop regression ownership lives in Playwright; this directory is mobile-only and drives the native surface via [Maestro](https://docs.maestro.dev/). The committed journeys run nightly, while ad-hoc agent exploration remains its primary authoring loop.

The structural payoff matches the desktop layer: the device (sim, emulator, or real) outlives the runner, so an agent (Claude Code) can attach, inspect the screen, take ad-hoc actions, screenshot, and resume. Maestro ships a first-party **MCP server** that exposes exactly that surface to Claude Code.

## One-time setup

```sh
# 1. Maestro CLI, pinned to the SAME version both CI lanes install
#    (MAESTRO_VERSION in .github/workflows/e2e.yml). Driving your local
#    simulator with a different CLI than the nightly is how a flow passes
#    here and reds there.
curl -fsSL "https://get.maestro.mobile.dev" | MAESTRO_VERSION=2.6.1 bash

# 2. JS deps. Worktrees inherit the lockfile but not node_modules.
bun install

# 3a. iOS path — build & install on a booted iOS Simulator.
bun run --filter=@centraid/mobile ios

# 3b. Android path — install Android cmdline-tools + API 35 (one-time
#     ~1.5 GB download), create an AVD, boot it, then build & install.
#     See "Android setup" below for the full sequence.
bun run --filter=@centraid/mobile android

# 4. Register Maestro's MCP server with Claude Code (one-time per
#    project). Run from a shell, not inside a flow.
claude mcp add maestro -- maestro mcp
```

After step 4, Claude Code gains MCP tools: `list_devices`, `inspect_view_hierarchy` (compact JSON tree), `take_screenshot`, `run_flow` (inline YAML), `tap_on`, `input_text`, `launch_app`, `stop_app`, `back`, plus `check_flow_syntax` / `query_docs` / `cheat_sheet`. That's the CDP-equivalent attach point — restart Claude Code after step 4 so it loads the new MCP server.

## Running flows

Locally you drive the **dev-client** rig, so Metro must be running before any flow:

```sh
cd apps/mobile && bunx expo start --dev-client
```

(The CI lanes do not: they install a release build with the bundle embedded and set `CENTRAID_MOBILE_BUILD=release`, on which the harness skips Metro entirely. See [Two rigs](#two-rigs-and-the-difference-is-the-whole-point).)

Then drive a flow:

```sh
node tests/agent-e2e-mobile/flows/home-loads.mjs
```

By default the harness picks **iOS first** if both a booted Simulator and a running emulator are present. Force a side with the `MAESTRO_PLATFORM` env var:

```sh
MAESTRO_PLATFORM=android node tests/agent-e2e-mobile/flows/home-loads.mjs
MAESTRO_PLATFORM=ios     node tests/agent-e2e-mobile/flows/home-loads.mjs
```

`runFlow()` prints the chosen target on the first line:

```
[runFlow] home-loads
  run dir : tests/agent-e2e-mobile/runs/home-loads-<runId>
  target  : android emulator-5554        # or: ios <UDID>
```

Per-run artifacts land under `runs/<slug>-<runId>/`:

```
runs/<slug>-<runId>/
  state.json                    ← runId, runDir, udid, appId
  flows/<NN-label>.yaml         ← every ctx.run() chunk, in order
  screenshots/<name>.png        ← whatever `takeScreenshot:` produced
  verdict.md                    ← PASS/FAIL + notes (written last)
```

`runs/` is gitignored — workspaces are tied to local sim UDIDs.

Maestro also keeps its own per-step debug artifacts (ai-report.html, failure screenshots) at `~/.maestro/tests/<timestamp>/`. Useful when a flow fails and the on-disk state alone isn't enough.

## Authoring a flow

Two files, same slug — mirrors the desktop convention:

```
flows/
  my-flow.md     ← prose intent: goal, setup, steps, expectations
  my-flow.mjs    ← runnable: calls runFlow() with the steps
```

Skeleton:

```js
import {
  DEV_LAUNCHER_HANDOFF,
  FIRST_LAUNCH_TIMEOUT_MS,
  runFlow,
} from "../lib/harness.mjs";

await runFlow("my-flow", async (ctx) => {
  // `ctx.state.appId` is the installed package for the resolved platform AND
  // build type — `dev.centraid.mobile` on iOS and on an Android RELEASE build,
  // `dev.centraid.mobile.debug` on an Android debug build (which carries the
  // `.debug` applicationIdSuffix). Don't hardcode it.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp: { clearState: true }
# Required after any cleared-state launch: on the dev client this hands the
# launcher its bundle URL, and on the release artifact it is the empty string.
${DEV_LAUNCHER_HANDOFF}- extendedWaitUntil:
    visible: { text: "All apps and places" }
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- takeScreenshot: home
`,
    "home"
  );

  ctx.note("observation worth keeping in verdict.md");

  await ctx.restart(); // stopApp + launchApp without clearState

  await ctx.run(`...`, "after-restart");
  return { pass: true, notes: "one-line summary for verdict" };
});
```

ctx surface:

- `ctx.state` — `{ runId, runDir, screenshotsDir, flowsDir, udid, appId }`
- `ctx.run(yaml, hint?, options?)` — execute a Maestro YAML chunk. Each call spawns `maestro test` once (~hundreds of ms overhead), so batch many directives per call rather than one-per-action. The harness uses the internal `sensitive` option only for capability-bearing input; it suppresses console/debug retention and keeps the live value in a `MAESTRO_*` variable.
- `ctx.restart()` — `stopApp` + `launchApp { clearState: false }` with a 300ms pre-stop delay (analogous to the desktop harness's flushMs before SIGTERM, gives AsyncStorage time to flush).
- `ctx.configureGateway(url?, token?)` — clear app state, mint a pairing ticket from the declared gateway (ownership: the ticket lands the phone in whichever owner host custody resolves — a fresh gateway founds a placeholder owner, a reused one lands on the owner an earlier flow already named), redeem it through the real ticket-only onboarding UI, and complete the test profile. Journeys that need a gateway call this themselves so their prerequisites do not depend on execution order. Live tickets and their Maestro diagnostics are never kept in uploaded run artifacts.
- `ctx.ensureDemo(appId)` — idempotently load the named gateway demo scenario before pairing. Each seeded Photos journey calls it when run independently. In `run-photos-suite.mjs`, the permissions journey first proves the empty-vault denial state, the library journey then seeds and pairs Photos, and the remaining journeys reuse that paired app state so the suite shares one boot and seed.
- `ctx.note(msg)` — record an observation; surfaces under `## Notes` in `verdict.md`.

Authoring rules of thumb (carried over from desktop):

- **Throw on failure, return `{ pass: true, notes }` on success.** Let the harness write the FAIL verdict — don't swallow with try/catch.
- **Verify the actual unit of truth.** For persistence claims, read the AsyncStorage manifest directly via `xcrun simctl get_app_container <udid> dev.centraid.mobile data` rather than only trusting Maestro's text matcher (see "Known caveats" below).
- **Slug = filename = `runFlow()` first arg.** Keeps verdicts and run dirs greppable.
- **Select on a `testID`, assert on copy only when the copy IS the claim.** The id vocabulary is [`apps/mobile/src/kit/test-ids.ts`](../../apps/mobile/src/kit/test-ids.ts) and `bun run lint:mobile-testids` fails when a flow references one that does not exist in the app source. A refusal sentence, a consequence sentence or a derived figure is a claim and stays a copy assertion; a locator is not.
- **A new flow file needs a row in [`roster.json`](roster.json)** before `bun run lint:e2e-wiring` will pass — status `scheduled`, `promoting` (staging non-blocking for five nights, per D3) or `exploratory`, plus the one-line claim it owns.

## Two rigs, and the difference is the whole point

Since [#890](https://github.com/srikanth235/centraid/issues/890) W1 this directory serves **two rigs that drive different artifacts**, and confusing them is how the old lane came to spend most of its time testing itself.

| Rig | Artifact | Bundler | When |
| --- | --- | --- | --- |
| **Local exploratory** | dev-client build (`expo run:ios` / `run:android`) | Metro, live | "try this journey, tell me what breaks" — the Claude Code ⇄ Maestro MCP loop, and the only place the dev-harness machinery below applies |
| **Scheduled CI lanes** | **release build with the Hermes bundle embedded** | none | every lane in the table below |

Every scheduled lane sets `CENTRAID_MOBILE_BUILD=release`, and on that path the harness skips Metro reachability, the bundle prewarm and the `adb reverse` entirely, `DEV_LAUNCHER_HANDOFF` is the empty string, and the Android package is `dev.centraid.mobile` rather than the `.debug` suffix. `scripts/test-report/validate-nightly-wiring.mjs` refuses a lane that starts Metro or builds iOS without `--configuration Release`, so the dev client cannot creep back one convenient step at a time.

The claims layer under all of it is unchanged: what belongs _here_ is the runtime, gesture, accessibility and OS-state claims no unit or component layer can falsify. What no longer belongs here is state variety — see [The roster shrinks](#the-roster-shrinks).

## The lanes

| Lane | Trigger | Platform | Runs | Blocking |
| --- | --- | --- | --- | --- |
| `mobile-device-gate` (`ci.yml`) | every mobile-touching PR | Android | `run-pr-gate-suite.mjs` — the critical five, ≤12 min warm ([budget](flows/pr-gate-budget.md)) | **yes** |
| `mobile-canary-android` (`mobile-canary.yml`) | every merge to `main` | Android | the full roster, and prebuilds the native shell the PR gate restores | no |
| `mobile-e2e-android` (`e2e.yml`) | nightly | Android | the full roster | no |
| `mobile-e2e-ios` (`e2e.yml`) | nightly | iOS | `run-ios-depth-suite.mjs` — the six claims that are facts about iOS, never a second copy ([budget](flows/ios-depth-budget.md)) | no |
| `alarm` (`mobile-alarm-test.yml`) | quarterly | Android | the critical five against a build with Home blanked, and **requires them to FAIL** | no |

Android gates PRs per D1 in [docs/decisions.md](../../docs/decisions.md#mobile-testing-890): Linux runners expose `/dev/kvm`, and UIAutomator2 is the stabler of the two Maestro drivers.

Every lane, and every flow it schedules, is declared in [`roster.json`](roster.json) and checked by `bun run lint:e2e-wiring`, which derives the real wiring from the shipped YAML and the shipped runners. A flow the roster calls `scheduled` that no lane runs is a hard failure — as is a `tests/matrix.json` owner nothing schedules, which is how `sharing-reach.mjs` spent its life being cited as evidence for a journey nobody ran.

## The committed roster

| Suite / flow | What it owns |
| --- | --- |
| `flows/pairing-canary.mjs` | the shared prerequisite: a ticket is minted, redeemed, and pairing completes to Home — in under five minutes, before anything fans out. First and short-circuiting in every suite that has one. |
| `run-pr-gate-suite.mjs` (5 flows) | the critical five that gate a PR — budget in [flows/pr-gate-budget.md](flows/pr-gate-budget.md) |
| `run-ios-depth-suite.mjs` (6 flows) | the iOS-only claims — budget in [flows/ios-depth-budget.md](flows/ios-depth-budget.md) |
| `run-photos-suite.mjs` (5 flows) | the Photos seat: refused permission, library, viewer, search, select-and-write — budget in [flows/photos-budget.md](flows/photos-budget.md) |
| `run-home-apps-suite.mjs` (7 flows) | the Docs, Agenda, Notes, Tasks, People, Tally and Locker seats — budget in [flows/home-apps-budget.md](flows/home-apps-budget.md) |
| `run-probes-suite.mjs` (6 flows) | the standalone journeys that grid G showed unbudgeted: `cold-start`, `home-loads`, `native-v0-resilience`, `places-seat`, `scroll-frames`, `volume-proof` — budget in [flows/probes-budget.md](flows/probes-budget.md) |
| `flows/sharing-reach.mjs` | the phone's one commons producer and the surface that makes a person reachable |

Every suite runner declares only `FLOWS` and `BUDGET_MS`; the shared body — spawn, the classified retry, the aggregate budget — is [`lib/run-suite.mjs`](lib/run-suite.mjs). Those two literals stay in each runner because `lint:e2e-wiring` and `validate-report-registries.mjs` read them off disk to derive what a lane schedules and what it may cost.

### The roster shrinks

A simulator minute on macOS costs roughly **600×** a vitest second on Linux, so the rule is not "add a journey for every claim" — it is the opposite. Before adding a flow, name the OS fact it needs a real device to observe. If you cannot, you have found a test for a cheaper tier:

- **state variety** — `dayone` / `pending` / `offline` / `stale` / `conflict` / `parked` — belongs in [`tests/integration-mobile/`](../integration-mobile/README.md), which runs a real replica session against a real gateway process on Linux. The device proves the native wiring **once** (one airplane-mode journey, not one per state).
- **RN role, accessible name, trait and responder semantics** belong in the `@centraid/mobile-rn` Vitest project.
- **pure logic** belongs in the package unit tiers.

### Instrumentation

Every run appends a record to [`ledger/durations.json`](ledger/README.md): duration, pass/fail, and the failure **class**. That ledger is what the derived budgets above become measured p95 ratchets from, and it is what the classified retry reads — see [`lib/retry-policy.mjs`](lib/retry-policy.mjs). **Retry is classification, not forgiveness:** one clean-state retry for an infrastructure-classified failure only, both attempts' evidence kept, and a product assertion never retried, because an `assertVisible` timeout is the exact shape a real regression takes.

### Origin acts

[`origin-acts.json`](origin-acts.json) holds every `seats.originActs` verb the app manifests declare — the acts only a phone can perform — against either an owning journey or a dated, reasoned gap. `bun run lint:seat-verbs` enforces it, so a new app or a new verb cannot land without one or the other. All six are gaps today, and that is the finding rather than an omission.

Tally has no journey here: it is held under issue #831.

## Device-only claims

The claims below are the reason this layer exists at all — each one is a fact about the **operating system's** behaviour, not the product's logic, so no unit, component, or Playwright layer can falsify it. Every row is written to be adoptable verbatim as a `tests/matrix.json` cell owner: the app, the seat or app-state it belongs to, the flow file that owns it, and the assertion that carries the claim.

`Seat` values are `docs/blueprint-seats.md`'s three seats; **only `origin` (the phone) can own any row here** — that is what makes them device-only. `State` values are the matrix's app-state vocabulary (`dayone`, `pending`, `offline`, `stale`, `conflict`, `parked`, `denied`).

### Owned

| App · seat / state | Flow file | The assertion that carries it | Why only a device |
| --- | --- | --- | --- |
| photos · origin / `denied` | `flows/photos-permissions.mjs` | launched with `permissions: { all: deny }`, then `Photos cannot reach your camera roll`, `Allow access\|Open Settings`, and `Select` asserted **disabled** | The refusal is the OS's, not the app's. Nothing below the device can produce a real denied `MediaLibrary` authorization, and the takeover has to hold on an _empty_ vault — the state in which a fabricated grid would be indistinguishable from a working one. |
| locker · origin / `denied` | `flows/locker-gate.mjs` | `Open Locker, locked` on Home (a **withheld** count, never `0`), then `Protect Locker` + `Create passphrase` asserted **disabled**, re-asserted after `ctx.restart()` | Two OS facts at once: that Home's launcher never read the one app it must not, and that no Locker session crossed a real process boundary. A component test renders whichever state it is handed; only killing the process proves nothing survived it. |
| photos · origin | `run-photos-suite.mjs` | see [flows/photos-budget.md](flows/photos-budget.md) | native grid, viewer gestures, and selection writes on the real replica |
| docs · origin | `flows/docs-drive.mjs` | `N · press and hold a row for quick actions`, then the breadcrumb, then a band tap that **pops** (`assertNotVisible: { id: "docs-breadcrumb" }` after landing on the Folders shelf, with the copy negative kept beside it) | The pop-not-push rule is a React Navigation stack fact. Both a push and a pop render the destination; only a real stack shows the second copy. The negative moved onto the handle because an `assertNotVisible` on COPY passes forever the day the copy is re-worded, and `lint:mobile-testids` holds the other end so the id cannot quietly stop naming anything (#890 W2). |
| agenda · origin | `flows/agenda-week.mjs` | `Go to today` + `New event`, then the Schedule surface's widened read carrying `Dinner with Maya` two days out, then the event screen's `Back to the agenda` | The Day and Schedule surfaces differ only by the size of the read (1 day vs 120); a fixture that hands both the same rows cannot tell them apart. |
| notes · origin | `flows/notes-library.mjs` | `Open Mom's chili, written down properly` **and** the body preview under it | The row and the body are two separate replica reads joined on device. A dropped join is headings above empty previews — green on every fixture that pre-merges them. |
| tasks · origin | `flows/tasks-board.mjs` | `Move all to today` + `N · nothing was deleted` on Today, then a nested subtask under its dated parent on Upcoming | The grouping arithmetic is pure and already covered; what is not is that the rows the phone's replica hands it are the vault's rows and land in the group the screen draws. |

### Gaps — device-only and unowned

Each row names what would own it, so it can be filed as a `gap` cell with a real acceptance test rather than a wish.

| App · seat / state | Gap | What would own it | Blocker |
| --- | --- | --- | --- |
| photos · origin | camera-roll permission **granted**, including iOS's _limited library_ selection | a flow launching with `permissions: { medialibrary: allow }` against a simulator whose library was filled by `xcrun simctl addmedia`, asserting the import offer (`CameraRollImportOffer.tsx`) rather than the refusal panel | needs a seeded simulator photo library in CI; the refused path (owned above) needs none, which is why it landed first |
| photos, docs · origin | **outbound share sheet** — `expo-sharing`'s `shareAsync` from the photo viewer (`src/apps/photos/photo-share.ts`) and the document export (`src/apps/docs/docs-export.ts`) | a flow that opens the share action and asserts the system sheet appeared and was dismissed without the app claiming a share it never made | the sheet is a system `UIActivityViewController`; its targets on a bare simulator are system apps only, so the assertion has to be about the sheet's appearance and the app's own post-dismiss state, not a delivered file |
| docs, notes · origin / `pending` | **inbound share intent** — `expo-share-intent` (`src/kit/hooks/ShareIntentIngest.tsx`) receiving a file from another app | Android is the tractable side: `adb shell am start -a android.intent.action.SEND` with a staged file, then assert the ingest surface | iOS needs a second app to share _from_; Android can synthesize the intent, so this gap should be closed Android-first |
| locker · origin | **biometric unlock** — `SecureStore` with `requireAuthentication: true` (`src/apps/locker/locker-device-auth.ts`) and the shell's device lock (`src/kit/security/AppLock.tsx` — `DEVICE LOCK` / `Centraid is locked`) | a flow that enrols the credential, backgrounds the app, and proves the OS prompt gated the reveal | **Maestro has no biometric control.** Android can be driven out of band (`adb -e emu finger touch <id>`); the iOS Simulator's Face ID enrolment/match is a Simulator.app menu action with no CLI Maestro can reach. Android-only until that changes. |
| — · origin / `denied` | **notification permission and delivery** — `src/lib/notifications-core.ts` asks with `requestPermissionsAsync`, and a tapped notification carries a `centraid://` URL into `src/deep-links.ts` | a flow launched with `permissions: { notifications: allow }`, then `xcrun simctl push` (iOS) / `adb shell am broadcast` (Android) of a payload carrying a deep link, asserting the app lands on the named screen | the delivery half is out-of-band tooling the harness does not wrap yet; the permission half alone would be a vacuous cell |
| locker · origin | the passphrase floor **transitioning** (a short passphrase still refused, a long one accepted) | a flow that types into the gate's field | the field is `secureTextEntry` (its value can never be read back) and its `accessibilityLabel` is on a React Native `TextInput`, which does not reach the iOS accessibility tree — see "Known caveats". It needs a relative-anchor selector validated against a live hierarchy, not one written out of the source. |
| docs · origin | the reading surface carrying the **current** version's bytes | an assertion on a body line that exists only in the seeded second version | the reading view renders the whole markdown body as ONE multi-line text node, and Maestro anchors a text selector to the whole node with a regex whose `.` does not cross newlines. Needs a single-line surface or an on-disk read. |
| tally · origin | the whole seat | a `tally-*.mjs` journey | closed: `flows/tally-derived.mjs` shipped under #873 and is scheduled on the roster lanes |

The declared **origin acts** — a camera, a scanner, a voice capture, an autofill provider — are tracked separately in [`origin-acts.json`](origin-acts.json), because those are enumerated by the app manifests and so can be checked for completeness in a way this prose table cannot. `bun run lint:seat-verbs` holds the two together.

## Android setup

The Android path is more stable than iOS at this stage (Maestro 2.x's UIAutomator2 driver hardens against Android API churn faster than its XCUITest driver against iOS 26.4). One-time setup:

```sh
# 1. Modern cmdline-tools (Android Studio not required). The legacy
#    tools/bin/sdkmanager that ships with older SDKs fails with
#    NoClassDefFoundError on modern Java.
brew install --cask android-commandlinetools

# 2. Install API 35 platform, build-tools, Google-Play system image,
#    and a fresh copy of cmdline-tools into the user SDK at
#    ~/Library/Android/sdk. The system image must be google_apis_playstore
#    (not google_apis) so the Expo dev client's manifest fetch works.
export ANDROID_HOME=$HOME/Library/Android/sdk
sdkmanager --sdk_root=$ANDROID_HOME \
  "platforms;android-35" \
  "system-images;android-35-ext15;google_apis_playstore;arm64-v8a" \
  "build-tools;35.0.0" "emulator" "platform-tools" "cmdline-tools;latest"

# 3. Create an AVD pointing at the new system image.
$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager create avd \
  --name Pixel_7_API_35 \
  --package "system-images;android-35-ext15;google_apis_playstore;arm64-v8a" \
  --device pixel_7

# 4. Boot it. Headed (default) makes debugging easier; for CI pass `-no-window`.
$ANDROID_HOME/emulator/emulator @Pixel_7_API_35 -no-snapshot-load &

# 5. Wait until adb reports `device` state, then build & install.
adb wait-for-device
bun run --filter=@centraid/mobile android
```

The committed `apps/mobile/android/` directory is missing some generated drawable resources (notably `splashscreen_logo`). If the first build fails with `error: resource drawable/splashscreen_logo … not found`, regenerate with:

```sh
cd apps/mobile && bunx expo prebuild --no-install --platform android --clean
```

That re-runs Expo's native-template generation. The resulting changes under `apps/mobile/android/` are local-only artifacts (similar to how `apps/mobile/ios/Centraid.xcodeproj/project.pbxproj` gets rewritten by `pod install`) — don't commit them. Reverting them after the build succeeds is safe; gradle's incremental build keeps working.

The harness automatically runs `adb reverse tcp:8081 tcp:8081` during `setup()` so the dev client (which fetches `http://localhost:8081`) reaches Metro on the host. No manual port forwarding needed.

## Known caveats

- **Maestro's iOS driver is the flakier of the two.** Observed on 2.x once a flow gets past ~10 commands — common failure modes are `Failed to connect to /127.0.0.1:7001`, `kAXErrorInvalidUIElement` from the accessibility tree, and visibility polls timing out on elements that _are_ visible in the hierarchy. **Keep iOS flows short and batch directives.** `home-loads.mjs` (5 directives) runs reliably on both platforms; longer flows on iOS have hit driver disconnects during text input. The Android driver (UIAutomator2) doesn't exhibit this — flows that work on both targets are best validated against Android first, and it is the reason D1 ([docs/decisions.md](../../docs/decisions.md#mobile-testing-890)) makes Android the PR-gate platform. Both lanes pin `MAESTRO_VERSION: 2.6.1`; the version is a single fact in `.github/workflows/e2e.yml`, not a number retyped in prose.
- **Maestro's text matcher misses RN `TextInput` values** in some cases — the value appears in `inspect_view_hierarchy` (under both `text=` and `value=`), but `assertVisible: "<substring>"` against it doesn't match. Read AsyncStorage from disk (see "Authoring rules of thumb") rather than relying on UI assertions for state.
- **A passing step is not a working step.** Every one of these was green in CI while doing nothing, and all of them came from writing selectors out of the React source instead of off a running app. Drive the simulator and read `inspect_view_hierarchy` before you trust a selector:
  - _Matching is substring-based._ `tapOn: "http://127.0.0.1:18789"` matched the help paragraph that mentions the URL, not the input below it. The tap "COMPLETED", the `inputText` went nowhere, and Save persisted an empty string. Disambiguate with a relative anchor (`below: "Dev fallback for simulators.*"`).
  - _An off-screen element still matches._ Maestro matches elements hidden behind the tab bar. Home's "Pair desktop" button is one, so tapping it is a silent no-op. `scrollUntilVisible` with `visibilityPercentage: 100` before asserting or tapping.
  - _Prefer a string unique to the target screen._ `assertVisible: "Settings"` passes on Home — the header gear, the tab, and the screen title are all "Settings". Assert "Desktop link" instead. Same trap for every tab label, which is on screen everywhere.
  - _Route names are not labels._ Settings calls `navigation.navigate('Apps', …)`, so `visible: "Apps"` looks right in the source — but the tab renders as "Home" and no "Apps" string exists in the app at all.
  - _The keyboard covers the bottom of the screen._ `hideKeyboard` before tapping anything below an input (e.g. Save).
  - _The first `inputText` on a clean simulator raises iOS's keyboard onboarding sheet_ ("Type English and Dutch … Continue"), which covers the tab bar and swallows later taps. CI boots a fresh simulator every run, so it hits this every time — use `DISMISS_KEYBOARD_ONBOARDING` from `lib/first-run.mjs` after typing.
- **`RN accessibilityLabel` on `TextInput` does not reach the iOS a11y tree** — the node keeps the placeholder as its `hintText` and gains no `accessibilityText`. Adding one to make a field selectable does not work; use a relative anchor instead.
- **Budget for a cold JS bundle.** `clearState: true` drops the dev build's cached bundle, so the first launch refetches it from Metro. On a cold transform cache that dominates the flow: `home-loads` measured ~19s end-to-end against a warm Metro and ~43s against a cold one on an M-series Mac, and the nightly runner is slower still. `setup()` first waits through Metro's bounded startup/reload window, then prewarms the bundle; flows use `FIRST_LAUNCH_TIMEOUT_MS` rather than a hand-picked 30s. This matters because Expo can answer `/status` once and briefly stop accepting requests while its file graph settles. A 30s launch budget or a one-shot readiness probe here makes the nightly `mobile-e2e` lane fail against copy that is entirely correct.
- **`launchApp: { clearState: true }`** wipes the dev client's stored "last opened" URL along with app state, so a plain relaunch sits on the launcher's empty server picker forever (`expo-dev-client`, shipped by #723). Every cleared-state launch MUST be followed by `- openLink: "${DEV_LAUNCHER_LINK}"` (exported from `lib/metro.mjs`) to hand the launcher the Metro bundle URL explicitly; `ctx.configureGateway()` and `home-loads.mjs` already do this. Non-cleared launches auto-resume the last session and need nothing.
- **Metro starts from `apps/mobile/` cwd.** Running it from the repo root resolves to an empty project root and fails with `Unable to resolve module expo`. Use `bunx expo start` from `apps/mobile/`, not `bun run` from root.
