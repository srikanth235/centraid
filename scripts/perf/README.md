# PWA fast-path perf budgets (issue #404, workstream I)

Instrumentation + CI budgets for the mobile/PWA fast path. This is the browser
sibling of the desktop waterfall probe
(`apps/desktop/tests/e2e-live/probe-open-waterfall.mjs`): it measures what it
costs to boot the shell and open an app over the PWA transport, and fences those
numbers so a future change can't silently re-inflate them.

## What's measured

The spec `apps/web/tests/e2e/perf-waterfall.spec.ts` runs three tests against the
real e2e harness gateway (`apps/web/tests/e2e/server.ts`, which installs the
`web-e2e` app and serves the shell over HTTP on `127.0.0.1:4173` with the service
worker active):

1. **App-open waterfall — shell + iframe, cold vs warm.** Loads the shell cold
   (empty cache), captures `performance.getEntriesByType('resource')` +
   navigation transfer, reloads into a signed-in shell to capture the warm load,
   then opens the installed app iframe cold and warm from the iframe's own origin
   (cross-origin timing would read 0 bytes). Writes
   `apps/web/test-results/perf-waterfall-report.json`.
2. **SW tunnel cache.** The page plays the tunnel-bridge role (as
   `web-pwa-cache.spec.ts` does), so it runs without the Iroh WASM. Proves a warm
   re-open is served from the service-worker cache: bridge round trips and
   tunnel-fetched bytes both collapse (the wave-1 SW-caching win).
3. **QUIC connection-pool instrumentation.** Drives several tunnel requests and
   reads `globalThis.__centraidIrohStats` to prove many request **streams** ride
   one endpoint **connect** (pool reuse). Falls back to asserting the
   instrumentation contract if the headless harness can't spawn a live iroh
   endpoint.

## Measured baseline (2026-07-14, headless Chromium)

| phase       | requests | transfer   | warm/cold |
| ----------- | -------- | ---------- | --------- |
| shell cold  | 6        | ~1,041 KB  | —         |
| shell warm  | 5        | 0 B        | 0.00      |
| app cold    | 0\*      | ~1.98 KB   | —         |
| app warm    | 0\*      | ~1.98 KB   | 0.999     |

QUIC pool: `{connects: 1, streams: 12, reconnects: 8}` → connects/streams ≈ 0.08.
SW tunnel cache: cold `calls=2 bytes=12288` → warm `calls=1 bytes=0`.

\* The `web-e2e` fixture is a bare HTML doc with an **inlined** runtime and no
external subresources, so the iframe has 0 `resource` entries; its cost is the
no-store navigation document (~1.98 KB). The shell bundle (the ~708 KB `boot`
chunk) is where the fast-path cost — and the bundling workstream's win — lives.

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

> A **fresh `vite build`** matters for test 3: the committed `apps/web/dist` is
> gitignored and may predate the `iroh-transport.ts` timing instrumentation. The
> runner rebuilds it; when a stale dist lacks the counters, test 3 skips itself
> with a message rather than failing.

## The budgets — and how to update them

All ceilings live in one file: **`apps/web/tests/e2e/perf-budgets.ts`**. Each
number is documented inline with its measured value and headroom rationale.

- **Hard gates:** request counts, transfer bytes, and the warm/cold + SW-tunnel
  + connect/stream ratios. These fail the build.
- **Soft gates:** wall-clock timings are log-only (`enforceTiming = false`) —
  wall clock on a shared CI runner is the flakiest signal. Flip `enforceTiming`
  to `true` and tighten the ceilings only once ~20 green CI runs show they're
  stable.

**When the bundling / code-split workstream lands** (or a richer app fixture is
wired), the request counts and byte totals will change:

1. Re-run `node scripts/perf/run-waterfall.mjs`.
2. Read the new numbers from the SUMMARY / report.
3. Update each ceiling in `perf-budgets.ts` to `measured + documented headroom`.
   When the numbers DROP, **tighten** — that's how the win is locked in and a
   future regression that re-inflates it gets caught.

## The instrumentation API (`src/iroh-transport.ts`)

Timing-only, guarded, zero behavior change:

- `globalThis.__centraidIrohStats: { connects, streams, reconnects }` — running
  counters. `connects` = endpoint spawns (memoized, ~1); `streams` =
  `node.request()` calls (one QUIC stream each, retries included); `reconnects` =
  retry rounds. After N pooled requests, `connects ≪ streams`.
- User Timing marks/measures: `centraid:iroh-connect` (endpoint spawn) and
  `centraid:iroh-request` (stream open → first response header/byte). Read them
  from a console or a test via `performance.getEntriesByName(...)`.
