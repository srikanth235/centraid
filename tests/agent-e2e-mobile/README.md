# Agent-driven exploratory QA — mobile

This is the committed manual-QA adapter for the Expo app on an iOS Simulator or Android emulator. Desktop regression ownership lives in Playwright; this directory is mobile-only and drives the native surface via [Maestro](https://docs.maestro.dev/). The committed journeys run nightly, while ad-hoc agent exploration remains its primary authoring loop.

The structural payoff matches the desktop layer: the device (sim, emulator, or real) outlives the runner, so an agent (Claude Code) can attach, inspect the screen, take ad-hoc actions, screenshot, and resume. Maestro ships a first-party **MCP server** that exposes exactly that surface to Claude Code.

## One-time setup

```sh
# 1. Maestro 2.x CLI (the `mcp` subcommand only exists in 2.x). The
#    versioned brew formula is the only path right now — the
#    cask-resolution default points at an unrelated music app, and the
#    plain `mobile-dev-inc/tap/maestro` formula tops out at 1.38.
brew install mobile-dev-inc/tap/maestro@2.0-dev.1

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

Metro must be running before any flow:

```sh
cd apps/mobile && bunx expo start --dev-client
```

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
import { runFlow, FIRST_LAUNCH_TIMEOUT_MS } from "../lib/harness.mjs";

await runFlow("my-flow", async (ctx) => {
  // `ctx.state.appId` is the installed package for the resolved platform —
  // `dev.centraid.mobile` on iOS, `dev.centraid.mobile.debug` on Android
  // (debug builds carry the `.debug` applicationIdSuffix). Don't hardcode it.
  await ctx.run(
    `appId: ${ctx.state.appId}
---
- launchApp: { clearState: true }
- extendedWaitUntil:
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

## Layered model

| Layer | Tool | When |
| --- | --- | --- |
| Agent-driven exploratory | Claude Code ⇄ Maestro MCP | "try this journey, tell me what breaks" — no committed flow needed |
| Committed regression (this dir) | `node flows/<slug>.mjs` → `maestro test` | flows that stabilized and you want runnable |
| CI-grade native invariants | committed Maestro flows in this directory | hard runtime, gesture, accessibility, and OS-state claims that unit/component layers cannot falsify |

## The committed roster

| Suite / flow | What it owns |
| --- | --- |
| `flows/home-loads.mjs` | ticket-only onboarding renders on a cleared client |
| `flows/native-v0-resilience.mjs` | all eight native covers open from Home, plus Settings and a process-restart smoke; Android additionally owns the airplane-mode pending-write restart |
| `run-photos-suite.mjs` (5 flows) | the Photos seat: refused permission, library, viewer, search, select-and-write — budget in [flows/photos-budget.md](flows/photos-budget.md) |
| `run-home-apps-suite.mjs` (5 flows) | the Docs, Agenda, Notes, Tasks and Locker seats — budget in [flows/home-apps-budget.md](flows/home-apps-budget.md) |
| `flows/places-seat.mjs` | the Places shelf, map, and pin readout over real `geo_lat`/`geo_lng` rows |
| `flows/cold-start.mjs`, `flows/scroll-frames.mjs`, `flows/volume-proof.mjs` | the three experience probes named by [tests/experience-budgets/mobile.json](../experience-budgets/mobile.json) |

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
| docs · origin | `flows/docs-drive.mjs` | `N · press and hold a row for quick actions`, then `Back to All`, then a band tap that **pops** (`assertNotVisible: "Back to All"` after landing on the Folders shelf) | The pop-not-push rule is a React Navigation stack fact. Both a push and a pop render the destination; only a real stack shows the second copy. |
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
| tally · origin | the whole seat | a `tally-*.mjs` journey | held under issue #831 |

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

- **Maestro `2.0-dev.1`'s iOS driver is flaky** on iOS 26.4 / Xcode 26.4.1 once a flow gets past ~10 commands — common failure modes are `Failed to connect to /127.0.0.1:7001`, `kAXErrorInvalidUIElement` from the accessibility tree, and visibility polls timing out on elements that _are_ visible in the hierarchy. **Keep iOS flows short and batch directives** until 2.x ships a stable release. `home-loads.mjs` (5 directives) runs reliably on both platforms; longer flows on iOS have hit driver disconnects during text input. The Android driver (UIAutomator2) doesn't exhibit this — flows that work on both targets are best validated against Android first.
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
- **`launchApp: { clearState: true }`** wipes the Expo dev client's cached Metro URL. The very first relaunch after clearState may show a red "No script URL provided" screen. The harness's Metro reachability check catches the obvious failure mode; if the redbox still appears, deep-link the dev client once with `xcrun simctl openurl <udid> "dev.centraid.mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"` to re-inject the URL.
- **Metro starts from `apps/mobile/` cwd.** Running it from the repo root resolves to an empty project root and fails with `Unable to resolve module expo`. Use `bunx expo start` from `apps/mobile/`, not `bun run` from root.
