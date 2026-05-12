# issue-23 — agent-e2e-mobile harness via Maestro MCP

GitHub issue: [#23](https://github.com/srikanth235/centraid/issues/23)

## Checklist

- [x] `tests/agent-e2e-mobile/` scaffolded with `lib/harness.mjs`, README.md, AGENTS.md, `.gitignore`
- [x] Platform-agnostic device discovery (iOS Simulator via `xcrun simctl`, Android emulator via `adb devices`); `MAESTRO_PLATFORM=ios|android` forces a side
- [x] App-install + Metro reachability preflight (platform-aware: `simctl get_app_container` vs `pm list packages`); Android-side `adb reverse tcp:8081 tcp:8081`
- [x] `ctx.run` pins Maestro to the chosen device with `--udid`; `ctx.restart` / `ctx.note` surface mirroring desktop's
- [x] Per-run dir layout: `state.json` + `flows/<NN-label>.yaml` + `screenshots/` + `verdict.md`
- [x] Maestro MCP server wired into Claude Code via `claude mcp add maestro -- maestro mcp`
- [x] Flow `home-loads` — proof-of-loop. Same file passes on both targets (iOS ~22s, Android ~50s)
- [ ] Flow exercising `ctx.restart()` + AsyncStorage persistence — deferred (see Out of scope)

## What changed

**`tests/agent-e2e-mobile/` scaffolded with `lib/harness.mjs`, README.md, AGENTS.md, `.gitignore`.** New directory at repo root, sibling to `tests/agent-e2e/`. The harness exports a single `runFlow(slug, fn)` orchestrator that does sim discovery → app-install check → Metro reachability check → run dir setup → exec the flow with `ctx.run` / `ctx.restart` / `ctx.note` → write verdict.md. Side CLI (`setup` / `list-devices`) exposed for ad-hoc driving. README is the user-facing how-to; AGENTS.md is the agent-judgment guide. `.gitignore` excludes `runs/`.

**Platform-agnostic device discovery (iOS Simulator via `xcrun simctl`, Android emulator via `adb devices`); `MAESTRO_PLATFORM=ios|android` forces a side.** `bootedDevice()` returns `{ udid, platform }` — tries iOS first (`xcrun simctl list devices booted --json`), then Android (`adb devices`). The env var forces a target when both are present, otherwise iOS wins. `state.json` and `verdict.md` record the chosen platform alongside the udid so the run is greppable by target.

**App-install + Metro reachability preflight (platform-aware: `simctl get_app_container` vs `pm list packages`); Android-side `adb reverse tcp:8081 tcp:8081`.** `appInstalled()` runs `simctl get_app_container <udid> <appId> app` on iOS, `adb -s <udid> shell pm list packages <appId>` on Android. For Android, `setup()` also runs `adb reverse tcp:8081 tcp:8081` so the dev client (which fetches `localhost:8081`) reaches Metro on the host. `metroReachable()` does a `fetch` against `http://127.0.0.1:8081/status` with a 1.5s timeout. Each precondition fails loudly with an actionable error message — without these checks, flow failures present as mysterious selector timeouts.

**`ctx.run` pins Maestro to the chosen device with `--udid`; `ctx.restart` / `ctx.note` surface mirroring desktop's.** Each `ctx.run(yaml, hint?)` writes the chunk to `flows/<NN-hint>.yaml` (audit trail) and spawns `maestro --udid <state.udid> test <flowFile>` with cwd set to `screenshots/` so `takeScreenshot:` directives land there. The `--udid` pin matters when both an iOS sim and an Android emulator are connected — without it Maestro picks the first available target and silently runs flows on the wrong platform (caught by spot-checking the per-run banner: `Running on Pixel_7_API_35` instead of the requested iPhone). `ctx.restart()` runs `stopApp` + `launchApp { clearState: false }` with a 300ms pre-stop delay — the mobile analogue of the desktop harness's `flushMs` before SIGTERM, giving AsyncStorage time to flush. `ctx.note(msg)` accumulates observations into `verdict.md`'s `## Notes` section.

**Per-run dir layout: `state.json` + `flows/<NN-label>.yaml` + `screenshots/` + `verdict.md`.** Same shape as desktop's runs dir. Always kept on PASS (unlike desktop which wipes the ephemeral userData workspace) — mobile run dirs are pure audit trail, not state seed.

**Maestro MCP server wired into Claude Code via `claude mcp add maestro -- maestro mcp`.** The structural payoff. Maestro 2.x ships an `mcp` subcommand that exposes `list_devices`, `inspect_view_hierarchy`, `take_screenshot`, `tap_on`, `input_text`, `launch_app`, `stop_app`, `run_flow`, `back`, plus `check_flow_syntax` / `query_docs` / `cheat_sheet` as MCP tools. Claude Code attaches once; the session stays alive across calls. Equivalent to the CDP attach point we have for the desktop side.

**Flow `home-loads` — proof-of-loop. Same file passes on both targets (iOS ~22s, Android ~50s).** Clean-state launch (`clearState: true`), waits up to 30s for the "Open Settings" text (proves dev-client downloaded the JS bundle from Metro and `<Home>` mounted in its no-gateway state), takes a screenshot, asserts both `"Open Settings"` and `"Connect to your desktop."` are visible. Five Maestro directives — short enough to stay clear of the Maestro 2.0-dev.1 iOS driver flakiness noted below.

## Out of scope

- **Second example flow exercising `ctx.restart()` + AsyncStorage persistence.** Initial attempt (`settings-set-gateway-persists`) used the UI to set a gateway URL, restarted, and read AsyncStorage from disk via `xcrun simctl get_app_container <udid> com.centraid.mobile data` (the rendered `TextInput` value is in `inspect_view_hierarchy` but Maestro's text matcher misses it). The on-disk verification approach is correct, but the 15-directive flow consistently hit Maestro 2.0-dev.1's iOS driver flakiness on iOS 26.4 — `Failed to connect to /127.0.0.1:7001`, `kAXErrorInvalidUIElement` from the accessibility tree, visibility polls timing out on elements that *are* present in the hierarchy. Driver-runner instability, not a flow-author bug. Revisit when Maestro 2.x ships a non-`-dev` release.
- **Detox-tier scripted invariants.** `apps/mobile/tests/e2e/` doesn't exist yet — the mobile sibling of `apps/desktop/tests/e2e/`. When a flow here stabilizes into a hard invariant, that's where it graduates.
- **WebView CDP bridge.** For tight DOM-level assertions inside the in-app WebView (`AppDetail` screen), Playwright over CDP into the WebView is the right tier. Not wired up; the React Native WebView component exposes a `webContentsDebuggingEnabled` style hook on Android and Safari Web Inspector on iOS — both reachable from a Playwright `chromium.connectOverCDP` once the right port is bridged.

## Verification

- `bun run check` is clean across the new files: oxfmt format check + oxlint, 0 warnings, 0 errors.
- `node tests/agent-e2e-mobile/flows/home-loads.mjs` PASS on both targets from the same file on a warm build:
  - **iOS:** `MAESTRO_PLATFORM=ios` → iPhone 17 sim, iOS 26.4, Maestro 2.0-dev.1, Metro on :8081 — ~22-44s depending on dev-client cold/warm state.
  - **Android:** `MAESTRO_PLATFORM=android` → Pixel_7_API_35 emu (API 35 ext15, Google Play, arm64-v8a), Metro reached via `adb reverse tcp:8081 tcp:8081` — ~50-64s including app cold launch.
  - Both produce `runs/<runId>/{state.json (with `platform` field), flows/01-home-fresh.yaml, screenshots/home-fresh.png, verdict.md}`.
- Maestro MCP health-check via `claude mcp list` reports the server as `✓ Connected`. From a fresh Claude Code session, `list_devices` returns both targets when running; `inspect_view_hierarchy` works against either.
- Preflight checks verified by inducing each failure: killing all targets → harness errors "No booted iOS Simulator or Android emulator"; uninstalling the app on each platform → "{appId} not installed on {platform} device {udid}"; stopping Metro → "Metro bundler not reachable at http://127.0.0.1:8081".
- Device-pinning bug caught and fixed in flight: an earlier version of `ctx.run()` invoked plain `maestro test <flow>` without `--udid`. Maestro silently picked the first connected target, so `MAESTRO_PLATFORM=ios` was reporting `target: ios <UDID>` in the harness banner but Maestro's own banner said `Running on Pixel_7_API_35`. Pinning with `--udid <state.udid>` aligns both.
- Two caveats documented but not fixed:
  - `launchApp: { clearState: true }` on iOS wipes the Expo dev client's cached Metro URL alongside AsyncStorage. First clearState after a Metro restart can show `"No script URL provided"` redbox; recover with `xcrun simctl openurl <udid> "com.centraid.mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"`.
  - Committed `apps/mobile/android/` is missing some generated drawables (`splashscreen_logo`). First Android build fails on resource linking; recover with `cd apps/mobile && bunx expo prebuild --no-install --platform android --clean`. The regenerated files are local-only side effects (same shape as `pod install`'s iOS `.pbxproj` rewrite).
