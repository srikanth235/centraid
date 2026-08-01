# PWA fast-path perf budgets (issue #404, workstream I)

Instrumentation + CI budgets for the mobile/PWA fast path. It measures what it costs to boot the shell and open an app over the PWA transport, and fences those numbers so a future change can't silently re-inflate them.

> **There is no desktop counterpart.** The old exploratory e2e-live harness and its waterfall probe are retired. The web spec below is the only budgeted perf rig in the repo today.

## What's measured

The spec `apps/web/tests/e2e/perf-waterfall.spec.ts` runs three tests against the real e2e harness gateway (`apps/web/tests/e2e/server.ts`, which installs the `web-e2e` app and serves the shell over HTTP on `127.0.0.1:4173` with the service worker active):

1. **App-open waterfall — shell + iframe, cold vs warm.** Loads the shell cold (empty cache), captures `performance.getEntriesByType('resource')` + navigation transfer, reloads into a signed-in shell to capture the warm load, then opens the installed app iframe cold and warm from the iframe's own origin (cross-origin timing would read 0 bytes). Writes `apps/web/test-results/perf-waterfall-report.json`.
2. **SW tunnel cache.** The page plays the tunnel-bridge role (as `web-pwa-cache.spec.ts` does), so it runs without the Iroh WASM. Proves a warm re-open is served from the service-worker cache: bridge round trips and tunnel-fetched bytes both collapse (the wave-1 SW-caching win).
3. **QUIC connection-pool instrumentation.** Drives several tunnel requests and reads `globalThis.__centraidIrohStats` to prove many request **streams** ride one endpoint **connect** (pool reuse). Falls back to asserting the instrumentation contract if the headless harness can't spawn a live iroh endpoint.

## Measured baseline (2026-07-14, headless Chromium)

| phase      | requests | transfer  | warm/cold |
| ---------- | -------- | --------- | --------- |
| shell cold | 6        | ~1,041 KB | —         |
| shell warm | 5        | 0 B       | 0.00      |
| app cold   | 0\*      | ~1.98 KB  | —         |
| app warm   | 0\*      | ~1.98 KB  | 0.999     |

QUIC pool: `{connects: 1, streams: 12, reconnects: 8}` → connects/streams ≈ 0.08. SW tunnel cache: cold `calls=2 bytes=12288` → warm `calls=1 bytes=0`.

\* The `web-e2e` fixture is a bare HTML doc with an **inlined** runtime and no external subresources, so the iframe has 0 `resource` entries; its cost is the no-store navigation document (~1.98 KB). The shell bundle (the ~708 KB `boot` chunk) is where the fast-path cost — and the bundling workstream's win — lives.

## Seeded volume (the calibration gap)

Per [docs/coding-standards.md](../../docs/coding-standards.md) ("Scale rigs are calibrated to year-3 volumes"), a rig states the data volume its numbers were measured at. This one's is **empty**: the `web-e2e` fixture is a single bare app in a fresh vault, so every number above is a cold-start cost, not a scale cost. Treat the budgets as a bundle/transport ratchet only — they cannot catch an O(vault-size) regression, because there is no vault size here to be O(). A rig seeded to declared year-3 volumes is the missing half, and its volume table belongs in this section when it lands.

## Running it

```sh
# From the repo root: build the package dists the harness loads (once).
bun run --cwd packages/app-engine build && bun run --cwd packages/gateway build

# Then, the one-command perf run (rebuilds web dist + runs the spec):
node scripts/perf/run-waterfall.mjs
node scripts/perf/summarize.mjs        # pretty-print the JSON report
```

It also runs as part of the normal web e2e suite (same Playwright `testDir`):

```sh
cd apps/web && bun run e2e            # runs every tests/e2e/*.spec.ts, incl. perf
```

> A **fresh `vite build`** matters for test 3: the committed `apps/web/dist` is gitignored and may predate the `iroh-transport.ts` timing instrumentation. The runner rebuilds it; when a stale dist lacks the counters, test 3 skips itself with a message rather than failing.

### `run-waterfall.mjs` measures UNCOMPRESSED bytes — read this before trusting a transfer number

`run-waterfall.mjs` runs a bare `vite build`. The web app's real build is `bun run --cwd apps/web build`, which is `… && vite build && node scripts/precompress.mjs` — so the runner **skips `precompress.mjs`**, and because `emptyOutDir` is on, it also **deletes the `.br`/`.gz` sidecars any previous full build left behind.**

`transferSize` is the **compressed** size. Measured through the runner, the cold shell reads about **1.79 MB**; measured against a properly precompressed dist it is about **422 KB**. Same code, same spec — a 4× difference that is entirely serving, not the bundle.

This has already cost one investigation (issue #659). The request counts and the warm/cold ratio are unaffected, so those stay trustworthy either way; only byte totals are distorted.

To get a byte number comparable to the recorded baselines in `apps/web/tests/e2e/perf-budgets.ts`:

```sh
bun run --cwd apps/web build          # the REAL build, including precompress
cd apps/web && bunx playwright test perf-waterfall \
  -c tests/e2e/playwright.config.ts -g "app-open waterfall"
```

Use `run-waterfall.mjs` for request counts, ratios, and the QUIC pool numbers; use the two commands above whenever a byte total is the point.

## The budgets — and how to update them

All ceilings live in one file: **`apps/web/tests/e2e/perf-budgets.ts`**. Each number is documented inline with its measured value and headroom rationale.

- **Hard gates:** request counts, transfer bytes, and the warm/cold + SW-tunnel
  - connect/stream ratios. These fail the build.
- **Soft gates:** wall-clock timings are log-only (`enforceTiming = false`) — wall clock on a shared CI runner is the flakiest signal. Flip `enforceTiming` to `true` and tighten the ceilings only once ~20 green CI runs show they're stable.

**When the bundling / code-split workstream lands** (or a richer app fixture is wired), the request counts and byte totals will change:

1. Re-run `node scripts/perf/run-waterfall.mjs`.
2. Read the new numbers from the SUMMARY / report.
3. Update each ceiling in `perf-budgets.ts` to `measured + documented headroom`. When the numbers DROP, **tighten** — that's how the win is locked in and a future regression that re-inflates it gets caught.

## The instrumentation API (`src/iroh-transport.ts`)

Timing-only, guarded, zero behavior change:

- `globalThis.__centraidIrohStats: { connects, streams, reconnects }` — running counters. `connects` = endpoint spawns (memoized, ~1); `streams` = `node.request()` calls (one QUIC stream each, retries included); `reconnects` = retry rounds. After N pooled requests, `connects ≪ streams`.
- User Timing marks/measures: `centraid:iroh-connect` (endpoint spawn) and `centraid:iroh-request` (stream open → first response header/byte). Read them from a console or a test via `performance.getEntriesByName(...)`.

## The other rigs in this directory (#659)

`run-waterfall.mjs` / `summarize.mjs` are the PWA rig described above. Two more things live here now:

- **`app-weight.mjs`** (R3d) — weighs the artifacts a user actually downloads: `apps/desktop/dist/renderer` and the two `expo export` outputs under `dist/mobile-bundle-smoke/`. Both builds already ran in CI on every desktop/mobile PR and had never been weighed. Run `bun run perf:app-weight -- --surface desktop|mobile` (add `--report` to print without failing). Ceilings live in `tests/experience-budgets/<surface>.json` and are tighten-only. Source maps are excluded as diagnostics; the script reports total shipped bytes AND the largest single chunk, because a total that holds while one chunk swallows everything is exactly what a code-split is meant to prevent.

  Measured 2026-07-31 (darwin arm64): desktop renderer **5,827,344 B** across 33 files, largest `react-boot.js` at 1,333,046 B. Mobile **11,596,398 B** (iOS) / **11,604,148 B** (Android), of which the Hermes bundle is 6,355,198 B.

- **Web vitals** (R3a) — `apps/web/tests/e2e/perf-waterfall.spec.ts` gained a fourth test capturing LCP / INP / CLS through observers installed via `addInitScript` (before any document script runs; an observer attached after paint measures a truncated timeline). Ceilings live in `tests/experience-budgets/web.json`.

  **Only CLS is gated today, and the reason is on the record.** In this harness (Playwright's bundled headless Chromium, 2026-07-31) the paint timeline contains `first-paint` and NEVER `first-contentful-paint`, so no LCP candidate is ever emitted — even though the connect screen renders fully in the accessibility snapshot and all three observers install. The probe reports the paint timeline in its annotation and its JSON, and the LCP/INP entries in `web.json` stay `unmeasured` with their intended ceilings parked under `_intendedCeilingMs`. Asserting a ceiling on a number the browser refuses to emit would pass vacuously forever.

## Experience budgets

`tests/experience-budgets/` (#659 R2) is the layer above every budget file named here: the same regressions written as what the vault owner feels, one file per surface, with an explicit `status` (`measured` / `projected` / `unmeasured`) on every metric and the year-3 volume each number was taken at. Read `tests/experience-budgets/README.md` before adding a number anywhere.
