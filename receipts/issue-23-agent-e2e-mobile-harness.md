# issue-23 — agent-e2e-mobile harness via Maestro MCP

GitHub issue: [#23](https://github.com/srikanth235/centraid/issues/23)

## Checklist

- [x] `tests/agent-e2e-mobile/` scaffolded with `lib/harness.mjs`, README.md, AGENTS.md, `.gitignore`
- [x] Booted-iOS-sim discovery via `xcrun simctl`, app-install + Metro reachability preflight
- [x] `ctx.run` / `ctx.restart` / `ctx.note` surface mirroring desktop's
- [x] Per-run dir layout: `state.json` + `flows/<NN-label>.yaml` + `screenshots/` + `verdict.md`
- [x] Maestro MCP server wired into Claude Code via `claude mcp add maestro -- maestro mcp`
- [x] Flow `home-loads` — proof-of-loop, passes in ~20s
- [ ] Flow exercising `ctx.restart()` + AsyncStorage persistence — deferred (see Out of scope)
- [ ] Android emulator path — deferred (see Out of scope)

## What changed

**`tests/agent-e2e-mobile/` scaffolded with `lib/harness.mjs`, README.md, AGENTS.md, `.gitignore`.** New directory at repo root, sibling to `tests/agent-e2e/`. The harness exports a single `runFlow(slug, fn)` orchestrator that does sim discovery → app-install check → Metro reachability check → run dir setup → exec the flow with `ctx.run` / `ctx.restart` / `ctx.note` → write verdict.md. Side CLI (`setup` / `list-devices`) exposed for ad-hoc driving. README is the user-facing how-to; AGENTS.md is the agent-judgment guide. `.gitignore` excludes `runs/`.

**Booted-iOS-sim discovery via `xcrun simctl`, app-install + Metro reachability preflight.** `setup()` lists booted simulators (`xcrun simctl list devices booted --json`), picks the first one, verifies `com.centraid.mobile` is installed there via `get_app_container`, and fetches `http://127.0.0.1:8081/status` with a 1.5s timeout to confirm Metro. Each precondition fails loudly with an actionable error message — without these checks, flow failures present as mysterious selector timeouts.

**`ctx.run` / `ctx.restart` / `ctx.note` surface mirroring desktop's.** Each `ctx.run(yaml, hint?)` writes the chunk to `flows/<NN-hint>.yaml` (audit trail) and spawns `maestro test <flowFile>` with cwd set to `screenshots/` so `takeScreenshot:` directives land there. `ctx.restart()` runs `stopApp` + `launchApp { clearState: false }` with a 300ms pre-stop delay — the mobile analogue of the desktop harness's `flushMs` before SIGTERM, giving AsyncStorage time to flush. `ctx.note(msg)` accumulates observations into `verdict.md`'s `## Notes` section.

**Per-run dir layout: `state.json` + `flows/<NN-label>.yaml` + `screenshots/` + `verdict.md`.** Same shape as desktop's runs dir. Always kept on PASS (unlike desktop which wipes the ephemeral userData workspace) — mobile run dirs are pure audit trail, not state seed.

**Maestro MCP server wired into Claude Code via `claude mcp add maestro -- maestro mcp`.** The structural payoff. Maestro 2.x ships an `mcp` subcommand that exposes `list_devices`, `inspect_view_hierarchy`, `take_screenshot`, `tap_on`, `input_text`, `launch_app`, `stop_app`, `run_flow`, `back`, plus `check_flow_syntax` / `query_docs` / `cheat_sheet` as MCP tools. Claude Code attaches once; the session stays alive across calls. Equivalent to the CDP attach point we have for the desktop side.

**Flow `home-loads` — proof-of-loop, passes in ~20s.** Clean-state launch (`clearState: true`), waits up to 30s for the "Open Settings" text (proves dev-client downloaded the JS bundle from Metro and `<Home>` mounted in its no-gateway state), takes a screenshot, asserts both `"Open Settings"` and `"Connect to your desktop."` are visible. Five Maestro directives — short enough to stay clear of the Maestro 2.0-dev.1 iOS driver flakiness noted below.

## Out of scope

- **Second example flow exercising `ctx.restart()` + AsyncStorage persistence.** Initial attempt (`settings-set-gateway-persists`) used the UI to set a gateway URL, restarted, and read AsyncStorage from disk via `xcrun simctl get_app_container <udid> com.centraid.mobile data` (the rendered `TextInput` value is in `inspect_view_hierarchy` but Maestro's text matcher misses it). The on-disk verification approach is correct, but the 15-directive flow consistently hit Maestro 2.0-dev.1's iOS driver flakiness on iOS 26.4 — `Failed to connect to /127.0.0.1:7001`, `kAXErrorInvalidUIElement` from the accessibility tree, visibility polls timing out on elements that *are* present in the hierarchy. Driver-runner instability, not a flow-author bug. Revisit when Maestro 2.x ships a non-`-dev` release.
- **Android emulator path.** Maestro is more stable on Android (UIAutomator2 vs XCUITest), so this is the more productive direction long-term. Needs harness extension for `adb`-based device discovery, Android-side AsyncStorage path (`/data/data/com.centraid.mobile/databases/RKStorage`), and the Android dev build first installed via `bun run --filter=@centraid/mobile android`. ~30-45 min of setup including the API 35 SDK image download.
- **Detox-tier scripted invariants.** `apps/mobile/tests/e2e/` doesn't exist yet — the mobile sibling of `apps/desktop/tests/e2e/`. When a flow here stabilizes into a hard invariant, that's where it graduates.
- **WebView CDP bridge.** For tight DOM-level assertions inside the in-app WebView (`AppDetail` screen), Playwright over CDP into the WebView is the right tier. Not wired up; the React Native WebView component exposes a `webContentsDebuggingEnabled` style hook on Android and Safari Web Inspector on iOS — both reachable from a Playwright `chromium.connectOverCDP` once the right port is bridged.

## Verification

- `bun run check` is clean across the new files: oxfmt format check + oxlint, 0 warnings, 0 errors.
- `node tests/agent-e2e-mobile/flows/home-loads.mjs` PASS in 23.7s on a warm build (iPhone 17 sim, iOS 26.4, Maestro 2.0-dev.1, Metro on :8081). Verdict.md written, screenshot captured at `runs/<runId>/screenshots/home-fresh.png`, audit YAML at `runs/<runId>/flows/01-home-fresh.yaml`.
- Maestro MCP health-check via `claude mcp list` reports the server as `✓ Connected`. From a fresh Claude Code session, `list_devices` returns the booted iPhone 17 sim plus available targets; `inspect_view_hierarchy` returns the Settings hierarchy with `accessibilityText` / `text` / `hintText` attributes per element.
- Preflight checks verified by inducing each failure: killing the sim → harness errors "No booted iOS Simulator"; uninstalling the app → "Centraid.app not installed on sim"; stopping Metro → "Metro bundler not reachable at http://127.0.0.1:8081" with the start command in the message.
- One known caveat documented but not fixed: `launchApp: { clearState: true }` wipes the Expo dev client's cached Metro URL alongside AsyncStorage. The first clearState after a Metro restart can show a `"No script URL provided"` redbox; recovery is a one-shot `xcrun simctl openurl <udid> "com.centraid.mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"` to re-inject the URL. Documented in README + AGENTS.md.
