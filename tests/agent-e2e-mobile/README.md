# Agent-driven exploratory QA — mobile

This is the committed manual-QA adapter for the Expo app on an iOS Simulator
or Android emulator. Desktop regression ownership lives in Playwright; this
directory is mobile-only and drives the native surface via
[Maestro](https://docs.maestro.dev/). The three stable journeys are also run
nightly, while ad-hoc agent exploration remains its primary authoring loop.

The structural payoff matches the desktop layer: the device (sim,
emulator, or real) outlives the runner, so an agent (Claude Code) can
attach, inspect the screen, take ad-hoc actions, screenshot, and
resume. Maestro ships a first-party **MCP server** that exposes
exactly that surface to Claude Code.

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

After step 4, Claude Code gains MCP tools: `list_devices`,
`inspect_view_hierarchy` (compact JSON tree), `take_screenshot`,
`run_flow` (inline YAML), `tap_on`, `input_text`, `launch_app`,
`stop_app`, `back`, plus `check_flow_syntax` / `query_docs` /
`cheat_sheet`. That's the CDP-equivalent attach point — restart Claude
Code after step 4 so it loads the new MCP server.

## Running flows

Metro must be running before any flow:

```sh
cd apps/mobile && bunx expo start --dev-client
```

Then drive a flow:

```sh
node tests/agent-e2e-mobile/flows/home-loads.mjs
```

By default the harness picks **iOS first** if both a booted Simulator
and a running emulator are present. Force a side with the
`MAESTRO_PLATFORM` env var:

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

Maestro also keeps its own per-step debug artifacts (ai-report.html,
failure screenshots) at `~/.maestro/tests/<timestamp>/`. Useful when a
flow fails and the on-disk state alone isn't enough.

## Authoring a flow

Two files, same slug — mirrors the desktop convention:

```
flows/
  my-flow.md     ← prose intent: goal, setup, steps, expectations
  my-flow.mjs    ← runnable: calls runFlow() with the steps
```

Skeleton:

```js
import { runFlow, APP_ID, FIRST_LAUNCH_TIMEOUT_MS } from '../lib/harness.mjs';

await runFlow('my-flow', async (ctx) => {
  await ctx.run(`appId: ${APP_ID}
---
- launchApp: { clearState: true }
- extendedWaitUntil:
    visible: { text: "Everything you build, in one place." }
    timeout: ${FIRST_LAUNCH_TIMEOUT_MS}
- takeScreenshot: home
`, 'home');

  ctx.note('observation worth keeping in verdict.md');

  await ctx.restart();        // stopApp + launchApp without clearState

  await ctx.run(`...`, 'after-restart');
  return { pass: true, notes: 'one-line summary for verdict' };
});
```

ctx surface:

- `ctx.state` — `{ runId, runDir, screenshotsDir, flowsDir, udid, appId }`
- `ctx.run(yaml, hint?)` — execute a Maestro YAML chunk. Each call
  spawns `maestro test` once (~hundreds of ms overhead), so batch
  many directives per call rather than one-per-action.
- `ctx.restart()` — `stopApp` + `launchApp { clearState: false }` with
  a 300ms pre-stop delay (analogous to the desktop harness's flushMs
  before SIGTERM, gives AsyncStorage time to flush).
- `ctx.configureGateway(url?, token?)` — clear app state, then save the
  declared gateway through the real Settings → Advanced UI. Journeys that
  need a gateway call this themselves so their prerequisites do not depend on
  execution order.
- `ctx.note(msg)` — record an observation; surfaces under `## Notes`
  in `verdict.md`.

Authoring rules of thumb (carried over from desktop):

- **Throw on failure, return `{ pass: true, notes }` on success.** Let
  the harness write the FAIL verdict — don't swallow with try/catch.
- **Verify the actual unit of truth.** For persistence claims, read
  the AsyncStorage manifest directly via
  `xcrun simctl get_app_container <udid> dev.centraid.mobile data`
  rather than only trusting Maestro's text matcher (see "Known
  caveats" below).
- **Slug = filename = `runFlow()` first arg.** Keeps verdicts and run
  dirs greppable.

## Layered model

| Layer | Tool | When |
|---|---|---|
| Agent-driven exploratory | Claude Code ⇄ Maestro MCP | "try this journey, tell me what breaks" — no committed flow needed |
| Committed regression (this dir) | `node flows/<slug>.mjs` → `maestro test` | flows that stabilized and you want runnable |
| CI-grade native invariants | Detox (not wired up) | hard invariants that must never flake |

For tight DOM-level assertions inside the in-app WebView (the
`AppDetail` screen), `apps/desktop/tests/e2e/`-style Playwright over
CDP against the WebView's debug port is the right tier, not Maestro.

## Android setup

The Android path is more stable than iOS at this stage (Maestro 2.x's
UIAutomator2 driver hardens against Android API churn faster than its
XCUITest driver against iOS 26.4). One-time setup:

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

The committed `apps/mobile/android/` directory is missing some
generated drawable resources (notably `splashscreen_logo`). If the
first build fails with `error: resource drawable/splashscreen_logo …
not found`, regenerate with:

```sh
cd apps/mobile && bunx expo prebuild --no-install --platform android --clean
```

That re-runs Expo's native-template generation. The resulting changes
under `apps/mobile/android/` are local-only artifacts (similar to how
`apps/mobile/ios/Centraid.xcodeproj/project.pbxproj` gets rewritten by
`pod install`) — don't commit them. Reverting them after the build
succeeds is safe; gradle's incremental build keeps working.

The harness automatically runs `adb reverse tcp:8081 tcp:8081` during
`setup()` so the dev client (which fetches `http://localhost:8081`)
reaches Metro on the host. No manual port forwarding needed.

## Known caveats

- **Maestro `2.0-dev.1`'s iOS driver is flaky** on iOS 26.4 / Xcode
  26.4.1 once a flow gets past ~10 commands — common failure modes
  are `Failed to connect to /127.0.0.1:7001`,
  `kAXErrorInvalidUIElement` from the accessibility tree, and
  visibility polls timing out on elements that *are* visible in the
  hierarchy. **Keep iOS flows short and batch directives** until 2.x
  ships a stable release. `home-loads.mjs` (5 directives) runs
  reliably on both platforms; longer flows on iOS have hit driver
  disconnects during text input. The Android driver (UIAutomator2)
  doesn't exhibit this — flows that work on both targets are best
  validated against Android first.
- **Maestro's text matcher misses RN `TextInput` values** in some
  cases — the value appears in `inspect_view_hierarchy` (under both
  `text=` and `value=`), but `assertVisible: "<substring>"` against
  it doesn't match. Read AsyncStorage from disk (see "Authoring
  rules of thumb") rather than relying on UI assertions for state.
- **A passing step is not a working step.** Every one of these was
  green in CI while doing nothing, and all of them came from writing
  selectors out of the React source instead of off a running app.
  Drive the simulator and read `inspect_view_hierarchy` before you
  trust a selector:
  - *Matching is substring-based.* `tapOn: "http://127.0.0.1:18789"`
    matched the help paragraph that mentions the URL, not the input
    below it. The tap "COMPLETED", the `inputText` went nowhere, and
    Save persisted an empty string. Disambiguate with a relative
    anchor (`below: "Dev fallback for simulators.*"`).
  - *An off-screen element still matches.* Maestro matches elements
    hidden behind the tab bar. Home's "Pair desktop" button is one, so
    tapping it is a silent no-op. `scrollUntilVisible` with
    `visibilityPercentage: 100` before asserting or tapping.
  - *Prefer a string unique to the target screen.* `assertVisible:
    "Settings"` passes on Home — the header gear, the tab, and the
    screen title are all "Settings". Assert "Desktop link" instead.
    Same trap for every tab label, which is on screen everywhere.
  - *Route names are not labels.* Settings calls
    `navigation.navigate('Apps', …)`, so `visible: "Apps"` looks right
    in the source — but the tab renders as "Home" and no "Apps" string
    exists in the app at all.
  - *The keyboard covers the bottom of the screen.* `hideKeyboard`
    before tapping anything below an input (e.g. Save).
  - *The first `inputText` on a clean simulator raises iOS's keyboard
    onboarding sheet* ("Type English and Dutch … Continue"), which
    covers the tab bar and swallows later taps. CI boots a fresh
    simulator every run, so it hits this every time — use
    `DISMISS_KEYBOARD_ONBOARDING` from the harness after typing.
- **`RN accessibilityLabel` on `TextInput` does not reach the iOS a11y
  tree** — the node keeps the placeholder as its `hintText` and gains no
  `accessibilityText`. Adding one to make a field selectable does not
  work; use a relative anchor instead.
- **Budget for a cold JS bundle.** `clearState: true` drops the dev
  build's cached bundle, so the first launch refetches it from Metro. On
  a cold transform cache that dominates the flow: `home-loads` measured
  ~19s end-to-end against a warm Metro and ~43s against a cold one on an
  M-series Mac, and the nightly runner is slower still. `setup()`
  prewarms the bundle, and flows use `FIRST_LAUNCH_TIMEOUT_MS` rather
  than a hand-picked 30s. A 30s budget here is what broke the nightly
  `mobile-e2e` lane against copy that was entirely correct.
- **`launchApp: { clearState: true }`** wipes the Expo dev client's
  cached Metro URL. The very first relaunch after clearState may
  show a red "No script URL provided" screen. The harness's Metro
  reachability check catches the obvious failure mode; if the
  redbox still appears, deep-link the dev client once with
  `xcrun simctl openurl <udid> "dev.centraid.mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"`
  to re-inject the URL.
- **Metro starts from `apps/mobile/` cwd.** Running it from the repo
  root resolves to an empty project root and fails with
  `Unable to resolve module expo`. Use `bunx expo start` from
  `apps/mobile/`, not `bun run` from root.
