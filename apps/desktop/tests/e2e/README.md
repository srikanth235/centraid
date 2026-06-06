# Desktop E2E

Playwright suite that drives the **real Electron app** against a per-test mock
gateway. Each test owns its own `userData` dir and HTTP listener — state never
leaks between tests.

## Architecture (post-#109/#137/#141)

The renderer is a thin HTTP client that talks to the **active gateway** directly
(Bearer token); app code lives in the gateway git store. `settings.json` no longer
carries a gateway URL/token — they're derived from the active gateway profile under
`<userData>/gateways/<id>/`. So the harness points the app at the mock by seeding a
**remote gateway profile** whose `url` is the mock, marking it active, and setting
`onboardingCompletedAt`. Apps / automations / runs / templates all come from the
gateway over HTTP, so the mock's `state` is the single source of fixture data.

## One-time setup

```sh
bun add -d @playwright/test
bunx playwright install chromium   # pulls Playwright's browser binaries on first run
```

In a git worktree, symlink the hoisted modules: `ln -s <main-checkout>/node_modules node_modules`.

## Running

```sh
# from apps/desktop
bun run test:e2e
```

The script builds the app first (`dist/main.js` is what `_electron.launch()` points
at) and then runs the specs.

## What's covered

59 tests across all 14 scenario sections (see [SCENARIOS.md](./SCENARIOS.md) for the
full matrix and what's deferred):

| Spec | Sections | What it exercises |
|---|---|---|
| `delete-app.spec.ts` | §3 | draft/published delete, offline/404, all dismiss paths |
| `onboarding-home.spec.ts` | §1, §2 | onboarding gate, tile badges, rename, menu, open app, sidebar, palette |
| `builder.spec.ts` | §4, §5, §6 | composer→builder, streamed turn, preview iframe, publish ok/fail, Code+SQL tabs, Database browse/paginate, Logs filter |
| `appview-templates-insights.spec.ts` | §7, §10, §11 | app iframe, copilot SSE turn, past-chats history, Discover clone, insights KPIs |
| `automations.spec.ts` | §8, §9 | list/error/retry, viewer, enable/webhook/delete/edit, run-viewer SSE timeline |
| `settings-gateways.spec.ts` | §12, §13, §14 | appearance prefs, Match-system, Agents page, gateway add/switch/rename/rotate/remove, auth error, Cmd+K |

## Fixtures (`fixtures.ts`)

- `startMockGateway()` — configurable HTTP server covering the whole gateway surface
  (apps, templates, automations, runs + nodes, versions, schema/rows/query/logs,
  prefs, runner/agents status, conversations) plus **SSE** for chat turns
  (`turnFrames`) and run events (`runFrames`). CORS + OPTIONS handled. Mutate
  `gateway.state` to shape fixture data and drive error branches
  (`deleteStatus`, `publishStatus`, `automationsStatus`, `forceStatus`, …).
- `makeEnv()` — fresh tmp `userData` + per-gateway `appsDir`.
- `seedRemoteGateway(env, gateway, { onboarding? })` — writes the remote `profile.json`
  + `centraid-settings.json` pointing at the mock. `onboarding: true` leaves the
  first-run view enabled.
- `launchApp(env)` — launches Electron with the per-test `--user-data-dir`.
- builders: `appEntry`, `automationRow`, `runRecord`, `runNode`.
- DOM helpers: `waitForHome`, `gotoNav`, `openTileMenu`, `clickMenuItem`,
  `expectConfirm`, `confirmDelete`, `markUserApp`.

Tests run serially (`workers: 1`) because each owns an Electron process.

## CI

Not run on PRs (it builds + launches Electron — too heavy for every push). It runs
**nightly** and on-demand via [`.github/workflows/e2e.yml`](../../../../.github/workflows/e2e.yml)
(`schedule` + `workflow_dispatch`), which installs the Playwright/Electron host deps and
runs the suite under `xvfb`. To reproduce a CI run locally on headless Linux:

```sh
xvfb-run --auto-servernum bun run test:e2e
```
