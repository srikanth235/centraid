# Desktop E2E

Playwright suite that drives the real Electron app against a per-test mock
gateway. Each test owns its own `userData` dir, `appsDir`, and HTTP
listener — state never leaks between tests.

## One-time setup

```sh
bun add -d @playwright/test
bunx playwright install chromium   # not strictly needed for Electron, but
                                   # Playwright pulls in browser binaries on
                                   # first run; this gets it out of the way.
```

## Running

```sh
# from apps/desktop
bun run test:e2e
```

The script builds the app first (`dist/main.js` is what `_electron.launch()`
points at) and then runs the spec.

## What's covered

`delete-app.spec.ts` exercises the five scenarios from the manual smoke-test
plan:

| Scenario | What it verifies                                                     |
| -------- | -------------------------------------------------------------------- |
| A        | Draft delete: confirm dialog → disk wipe → no gateway call           |
| B        | Published delete (gateway OK): tile gone, DELETE sent with auth      |
| C        | Gateway offline: error toast, tile remains, local files preserved    |
| D        | Gateway 404 (idempotent): treated as success, local cleanup runs     |
| E.1–4    | Cancel paths: button, Esc, backdrop click, Enter-to-confirm          |

## Adding tests

The fixtures in `fixtures.ts` give you the primitives:

- `makeEnv()` — fresh tmp workspace.
- `startMockGateway()` — loopback HTTP server with a tunable `deleteStatus`
  and a `calls` array you can assert on.
- `seedSettings(env, gateway)` — writes `centraid-settings.json` so the main
  process picks up the test gateway on startup.
- `seedPublishedApp(env, page, app)` — lays down an app dir + the matching
  `userApps` entry in `localStorage`.
- `seedDraftApp(env, app)` — app dir only; `hydrateDrafts()` picks
  it up on home render.
- `launchApp(env)` — launches Electron with the per-test `--user-data-dir`.

Tests run serially (`workers: 1`) because each owns an Electron process and
the screen real estate that brings.

## CI

Headless on Linux needs `xvfb`:

```sh
xvfb-run --auto-servernum bun run test:e2e
```

The suite assumes the gateway never makes outbound network calls — the mock
swallows ambient requests with a `200 {}` so the renderer can render without
hitting anything real.
