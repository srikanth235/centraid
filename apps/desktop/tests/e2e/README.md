# Desktop E2E (canonical)

Playwright suite that drives the **real Electron app**. This directory is the **canonical desktop journey suite** ([TESTING.md](../../../../TESTING.md), issue #458 / #468 L3). It runs nightly via `.github/workflows/e2e.yml` and on PRs that touch `apps/desktop` or `packages/client` via `.github/workflows/client-e2e-pr.yml`.

The retired exploratory `tests/e2e-live/` harness is intentionally absent; this Playwright suite is the only desktop journey surface.

## Architecture (post-#109/#137/#141)

The renderer is a thin HTTP client that talks to the **active gateway** directly (Bearer token); app code lives in the gateway git store. Specs seed a remote gateway profile or exercise the local gateway as needed.

## Running

```sh
# from apps/desktop
bun run test:e2e
```

The script builds the app first (`dist/main.js` is what `_electron.launch()` points at) and then runs the specs.

## Coverage

See [SCENARIOS.md](./SCENARIOS.md) for the scenario matrix.
