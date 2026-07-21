# Desktop E2E (canonical)

Playwright suite that drives the **real Electron app**. This directory is the
**canonical desktop journey suite** ([TESTING.md](../../../../TESTING.md),
issue #458 / #468 L3). It runs nightly via `.github/workflows/e2e.yml` and on
PRs that touch `apps/desktop` or `packages/client` via
`.github/workflows/client-e2e-pr.yml`.

> Note: older copies of this README called a sibling directory "stale". That
> claim lost — **TESTING.md wins**. `tests/e2e-live/` is exploratory only.

## Architecture (post-#109/#137/#141)

The renderer is a thin HTTP client that talks to the **active gateway** directly
(Bearer token); app code lives in the gateway git store. Specs seed a remote
gateway profile or exercise the local gateway as needed.

## Running

```sh
# from apps/desktop
bun run test:e2e
```

The script builds the app first (`dist/main.js` is what `_electron.launch()`
points at) and then runs the specs.

## Coverage

See [SCENARIOS.md](./SCENARIOS.md) for the scenario matrix.
