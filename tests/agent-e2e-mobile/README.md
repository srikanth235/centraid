# Agent-driven e2e — mobile

Mobile counterpart to [`tests/agent-e2e/`](../agent-e2e/README.md). That
layer drives Electron over CDP via Playwright; this one drives the Expo
app on an iOS Simulator via [Maestro](https://docs.maestro.dev/).

The structural payoff matches the desktop layer: the device (sim or
real) outlives the runner, so an agent (Claude Code) can attach,
inspect the screen, take ad-hoc actions, screenshot, and resume.
Maestro ships a first-party **MCP server** that exposes exactly that
surface to Claude Code.

## One-time setup

```sh
# 1. Maestro 2.x CLI (the `mcp` subcommand only exists in 2.x). The
#    versioned brew formula is the only path right now — the
#    cask-resolution default points at an unrelated music app, and the
#    plain `mobile-dev-inc/tap/maestro` formula tops out at 1.38.
brew install mobile-dev-inc/tap/maestro@2.0-dev.1

# 2. JS deps. Worktrees inherit the lockfile but not node_modules.
bun install

# 3. Build & install the standalone dev app on a booted iOS Simulator.
bun run --filter=@centraid/mobile ios

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
import { runFlow, APP_ID } from '../lib/harness.mjs';

await runFlow('my-flow', async (ctx) => {
  await ctx.run(`appId: ${APP_ID}
---
- launchApp: { clearState: true }
- extendedWaitUntil:
    visible: { text: "Open Settings" }
    timeout: 30000
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
- `ctx.note(msg)` — record an observation; surfaces under `## Notes`
  in `verdict.md`.

Authoring rules of thumb (carried over from desktop):

- **Throw on failure, return `{ pass: true, notes }` on success.** Let
  the harness write the FAIL verdict — don't swallow with try/catch.
- **Verify the actual unit of truth.** For persistence claims, read
  the AsyncStorage manifest directly via
  `xcrun simctl get_app_container <udid> com.centraid.mobile data`
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

## Known caveats

- **Maestro `2.0-dev.1` is a prerelease.** Its iOS driver (XCUITest)
  is flaky on iOS 26.4 / Xcode 26.4.1 once a flow gets past ~10
  commands — common failure modes are `Failed to connect to /127.0.0.1:7001`,
  `kAXErrorInvalidUIElement` from the accessibility tree, and
  visibility polls timing out on elements that *are* visible in the
  hierarchy. **Keep flows short and batch directives** until 2.x
  ships a stable release. `home-loads.mjs` (5 directives) runs
  reliably; longer flows have hit driver disconnects during text
  input.
- **Maestro's text matcher misses RN `TextInput` values** in some
  cases — the value appears in `inspect_view_hierarchy` (under both
  `text=` and `value=`), but `assertVisible: "<substring>"` against
  it doesn't match. Read AsyncStorage from disk (see "Authoring
  rules of thumb") rather than relying on UI assertions for state.
- **`launchApp: { clearState: true }`** wipes the Expo dev client's
  cached Metro URL. The very first relaunch after clearState may
  show a red "No script URL provided" screen. The harness's Metro
  reachability check catches the obvious failure mode; if the
  redbox still appears, deep-link the dev client once with
  `xcrun simctl openurl <udid> "com.centraid.mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"`
  to re-inject the URL.
- **Metro starts from `apps/mobile/` cwd.** Running it from the repo
  root resolves to an empty project root and fails with
  `Unable to resolve module expo`. Use `bunx expo start` from
  `apps/mobile/`, not `bun run` from root.
