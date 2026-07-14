# issue-404 — Mobile fast path: transport pooling, wire compression, PWA caching, app hygiene

GitHub issue: [#404](https://github.com/srikanth235/centraid/issues/404)

Wave 1 of the mobile fast path: make the PWA-over-relay surface stop paying
a fresh QUIC handshake per request, compress everything compressible on the
wire, cache tunneled responses on the device, and stop the blueprint apps
from refetching/reshipping data they don't need. All work verified against
the 2026-07-14 audit's file:line ground truth.

## Checklist

- [x] Commit 1 — app-engine + tunnel: wire compression, ETag memoization, SSE radio discipline
- [x] Commit 2 — web: pooled QUIC connection + keep-alive in the iroh-wasm endpoint
- [x] Commit 3 — web: PWA caching, gzip decode, transport retry, persist, icons, poll gating
- [x] Commit 4 — blueprints: photos grid never fetches originals
- [x] Commit 5 — blueprints: app data hygiene + kit helpers across the other 7 apps

## What changed

### Commit 1 — app-engine + tunnel: wire compression, ETag memoization, SSE radio discipline

Files: `packages/app-engine/src/http/compression.ts` (new),
`packages/app-engine/src/http/compression.test.ts` (new),
`packages/app-engine/src/http/asset-variants.ts` (new, split from static-server),
`packages/app-engine/src/http/bridge-script.ts` (new, split from static-server),
`packages/app-engine/src/http/static-server.ts`,
`packages/app-engine/src/http/static-server.test.ts`,
`packages/app-engine/src/runtime.ts`,
`packages/app-engine/src/http/changes-sse.ts`,
`packages/tunnel/src/gateway-endpoint.ts`.

- **Wire compression** (there was none anywhere): Accept-Encoding-negotiated
  brotli/gzip for compressible types (`text/*` except SSE, JSON, JS, XML,
  SVG, manifest) on static assets, the HTML shell, and tool-route JSON.
  Skips bodies < 1 KiB, already-encoded content, SSE, and Range/206.
  Dynamic responses compress at brotli 4 / gzip 6; static assets at
  brotli 10 / gzip 9 with the compressed variant cached per
  (path, mtime, size) so unchanged files are never recompressed.
  `Vary: Accept-Encoding` on every compressible response; ETags stay keyed
  to raw bytes (content identity, safe under Vary).
- **ETag memoization**: plain-file sha256 ETags cached by (path, mtime,
  size) exactly like the existing JSX cache — a 304 revalidation no longer
  re-reads or re-hashes the file (tested with an fs spy).
- **SSE bridge radio discipline** (injected client bridge): flat 5 s
  reconnect → exponential backoff with jitter (1 s → 30 s cap, reset on
  open); the EventSource now closes on `visibilitychange`-hidden /
  `pagehide` (freeing a server subscriber slot) and reconnects on visible.
  `window.centraid.onChange` contract unchanged.
- **Heartbeat** 30 s → 55 s (fewer radio wakeups, still under 60 s idle
  proxy cuts).
- **Tunnel chunk copy**: `Array.from(chunk)` per response chunk replaced
  with a preallocated single-pass conversion. A copy-free Buffer write is
  impossible through the current iroh JS binding (Vec<u8> params reject
  Uint8Array/Buffer — verified at runtime), so the copy is minimized, and
  compression shrinks the bytes crossing it.
- **File-size hygiene**: the compression work pushed `static-server.ts`
  past the 500-line cap, so the variant/etag cache moved to
  `asset-variants.ts` and the injected bridge to `bridge-script.ts`
  (mechanical extraction, no behavior change; static-server is 448 lines).

### Commit 2 — web: pooled QUIC connection + keep-alive in the iroh-wasm endpoint

Files: `apps/web/iroh-wasm/src/lib.rs`,
`apps/web/scripts/build-iroh-wasm.sh`,
`apps/web/src/generated/centraid_web_iroh.js`,
`apps/web/src/generated/centraid_web_iroh.d.ts`,
`apps/web/src/generated/centraid_web_iroh_bg.wasm`,
`apps/web/src/generated/centraid_web_iroh_bg.wasm.d.ts`.

- The `BrowserEndpoint` previously dialed a fresh QUIC connection through
  the relay for every request and closed it when the response body ended
  (~2–3 RTT of handshake per request, ~28 per cold app open). It now
  caches the tunnel `Connection` and opens one bi-stream per request;
  stream-end no longer closes the shared connection, so a held-open SSE
  stream and concurrent short requests multiplex over one connection.
  Dead/stale connections are detected and redialed once. QUIC transport
  config: keep-alive 15 s, max idle 60 s. `pair_gateway` stays per-call
  (one-shot, different ALPN).
- `build-iroh-wasm.sh` gains a guarded `wasm-opt -Oz` pass (skips with a
  warning when binaryen is absent — it is absent on this machine, so the
  committed wasm is unshrunk: 2,182,419 bytes, +1.3 KB for the pool).
- Generated bindings regenerated; the TS-facing API surface is unchanged.

### Commit 3 — web: PWA caching, gzip decode, transport retry, persist, icons, poll gating

Files: `apps/web/public/sw.js`, `apps/web/src/iroh-transport.ts`,
`apps/web/src/web-host.ts`, `apps/web/src/sw-lifecycle.ts` (new, split),
`apps/web/src/connectivity.ts` (new, split), `apps/web/index.html`,
`apps/web/public/manifest.webmanifest`,
`apps/web/public/icon-192.png` (new), `apps/web/public/icon-512.png` (new),
`apps/web/public/icon-maskable-512.png` (new),
`apps/web/public/apple-touch-icon-180.png` (new),
`apps/web/tests/e2e/web-pwa-cache.spec.ts` (new).

- **Service worker**: shell handler switched from network-first to
  stale-while-revalidate (cached shell paints immediately, revalidates in
  background; `/web-config.json` stays network-only). Tunneled responses
  are now cached: `/_vault/blobs/` cache-first (content-addressed,
  immutable; LRU ~300 MB / 2000 entries), ETag-bearing app assets
  stale-while-revalidate with background `If-None-Match` conditional
  revalidation through the same bridge (304 keeps, 200 replaces). Never
  cached: non-GET, SSE, `no-store` app HTML (per-response nonce), non-200,
  Range/206, > 20 MB. Cache keys strip the per-session bridge id so warm
  relaunches hit; unpair purges the tunnel caches; single `VERSION` const
  feeds all cache names.
- **PWA-side gzip**: tunneled requests advertise `accept-encoding: gzip`;
  responses decode via `DecompressionStream` at the Response-synthesis
  choke points (`tunnel()`, `revalidateAsset()`, `irohFetch()`), with
  `content-encoding`/`content-length` stripped and caches storing decoded
  bytes. Browsers never auto-decode SW-synthesized responses and
  JS-forwarded headers never include Accept-Encoding, so without this the
  PWA — the mobile surface — would receive raw bytes forever.
- **Transport retry** (`iroh-transport.ts`): 15 s connect timeout and up
  to 2 jittered retries for transient failures, idempotency-aware (POSTs
  only retry on clear pre-send connect failure).
- **Update flow**: post-load `controllerchange` surfaces the existing
  "Relaunch to update" affordance instead of reloading mid-use.
- **`navigator.storage.persist()`** requested after successful pairing
  (iOS ~7-day eviction would destroy the iroh device key → forced
  re-pair); grant recorded in settings.
- **Health poll**: paused while hidden, immediate refresh on return,
  interval 5 s → 15 s (consumers only need up/down).
- **iOS installability**: real PNG icons (192/512/maskable-512/180
  apple-touch) rasterized from `centraid.svg` via Playwright chromium;
  manifest + `apple-touch-icon` updated (SVG-only before — broken on iOS).
- **File-size hygiene**: `web-host.ts` exceeded the 500-line cap after the
  additions; SW lifecycle helpers moved to `sw-lifecycle.ts` and the
  connectivity tester to `connectivity.ts` (mechanical, no behavior
  change; web-host is 484 lines).

### Commit 4 — blueprints: photos grid never fetches originals

Files: `packages/blueprints/apps/photos/media.js`,
`packages/blueprints/apps/photos/app.jsx`,
`packages/blueprints/apps/photos/app.css`,
`packages/blueprints/apps/photos/components/Timeline.jsx`,
`packages/blueprints/apps/photos/components/Lightbox.jsx`.

- Thumb-miss renders a neutral shimmer placeholder — never
  `content_uri`: `makeThumb()`/`setThumbSrc()` (client-side downscaling
  of full originals, unbounded base64 cache) deleted; `<img onerror>`
  swaps to a placeholder instead of the original; video tiles are
  placeholder + play glyph with bytes loading only in the lightbox.
- `decoding="async"` on grid/lightbox/filmstrip images; grid images carry
  width/height from known dims (no CLS).
- Search: the per-keystroke full re-sort/re-bucket/re-justify of up to
  2,000 tiles is debounced 180 ms trailing; the input is uncontrolled so
  typing echoes instantly.
- `onChange` subscription added (photos previously only refreshed on
  focus): debounced 200 ms and skipped unless the change's `tables`
  intersect the 9 tables the library projection reads.
- Focus refresh skipped when the last granted load is < 30 s old (boot
  consent walk unaffected — the gate exempts the boot load).
- Timeline windowing via `content-visibility: auto` +
  `contain-intrinsic-size` on rows — off-screen rows skip layout/paint/
  decode with zero structural change to the justified layout.
- "Show more" keeps the full re-read (the vault read API has no
  offset/cursor — noted for #405/#406) but renders incrementally via
  stable keys.

### Commit 5 — blueprints: app data hygiene + kit helpers across the other 7 apps

Files: `packages/blueprints/kit/kit.js`,
`packages/blueprints/apps/notes/queries/library.js`,
`packages/blueprints/apps/notes/queries/search.js`,
`packages/blueprints/apps/notes/queries/note.js` (new),
`packages/blueprints/apps/notes/app.json`,
`packages/blueprints/apps/notes/app.jsx`,
`packages/blueprints/apps/notes/chrome.js`,
`packages/blueprints/apps/notes/components/Card.jsx`,
`packages/blueprints/apps/notes/logic.js`,
`packages/blueprints/apps/agenda/queries/upcoming.js`,
`packages/blueprints/apps/agenda/app.jsx`,
`packages/blueprints/apps/agenda/chrome.js`,
`packages/blueprints/apps/tasks/logic.js`,
`packages/blueprints/apps/tasks/app.jsx`,
`packages/blueprints/apps/tasks/chrome.js`,
`packages/blueprints/apps/tally/app.jsx`,
`packages/blueprints/apps/tally/chrome.js`,
`packages/blueprints/apps/locker/app.jsx`,
`packages/blueprints/apps/locker/queries/items.js`,
`packages/blueprints/apps/people/app.jsx`,
`packages/blueprints/apps/people/chrome.js`,
`packages/blueprints/apps/docs/app.jsx`,
`packages/blueprints/apps/docs/chrome.js`,
`packages/blueprints/manifest.json`,
`packages/blueprints/src/query-handlers.test.ts` (new).

- **Kit helpers** (`kit.js`): `onDataChange(tables, cb, {debounceMs})`
  (debounced, tables-filtered doorbell subscription; empty `tables` on an
  event always fires — the runtime emits empty for handler writes),
  `onFocusRefresh(cb, {minIntervalMs})` (staleness-gated focus refresh,
  always fires while the consent banner is visible), `observeWidth(el,
  breakpoint, onNarrow)` (ResizeObserver; visibility-gated interval
  fallback only where RO is unavailable).
- **Notes**: list/search projections ship a ≤200-char `preview` +
  checklist counts instead of every note's full decoded body; new `note`
  query (in `app.json`, handler `queries/note.js`) fetches the body on
  open; editor/autosave updated accordingly. `manifest.json` regenerated
  (one added line for the new query handler).
- **Agenda**: recurring-event reads capped; open-ended expansion window
  366 d → 120 d; per-series expansion memoized (keyed by event id +
  updated_at + dtstart + rrule + range); global 1,500-instance cap. Also
  fixes a latent pre-existing crash: ISO-string ranges hitting
  `expandRrule`'s `.getTime()` silently emptied the agenda whenever any
  recurring event existed.
- **Tasks**: optimistic checkbox toggle — flip immediately, write, then
  reconcile via the debounced doorbell; parked shows the existing pending
  chip; failure reverts with the existing error affordance. Toggle is now
  1 RTT on the critical path (was 2 serial).
- **Tally**: `refreshAll` parallelizes dashboard + view reads
  (add-expense 3 serial RTTs → 2).
- **Locker**: one watchtower unseal per refresh (the `items` query returns
  the watchtower summary; the separate always-unsealing query call is
  dropped) and one shared `core.concept`/`core.concept_scheme` read
  (was two of each).
- **All seven apps**: `onChange` debounce + tables filtering, staleness-
  gated focus refresh, and ResizeObserver width tracking replacing the
  perpetual 4 Hz `setInterval` layout pollers.

## Decisions

- **Compression gate is negotiation-only** (no custom header flag).
  JS-forwarded headers never carry `Accept-Encoding`, so the synthesized-
  Response transports (SW tunnel, `irohFetch`) were safe by construction —
  and then explicitly opted in with client-side
  `DecompressionStream('gzip')` decode. gzip-only on the PWA path
  (DecompressionStream has no brotli); desktop/native negotiate brotli.
- **Blob range streaming deferred**: `custody.open` fully buffers ranges
  in `packages/vault`; that fix belongs to the storage tier (#405).
- **Photos "Show more" keeps the full re-read**: the vault read API has no
  offset/cursor; incremental rendering via stable keys mitigates. Flagged
  for the replica protocol (#406) where reads go local anyway.
- **`wasm-opt` wired but inactive**: binaryen is not installed on this
  machine; the build script warns and skips. Install binaryen and rebuild
  to shrink the 2.08 MB wasm ~10–20 %.
- **File-size cap compliance by extraction**: `static-server.ts` and
  `web-host.ts` crossed 500 lines from legitimate additions; both were
  split mechanically (asset-variants/bridge-script, sw-lifecycle/
  connectivity) rather than waived.
- **Pre-existing repo red, not addressed here** (verified present on the
  clean base with all wave-1 changes stashed): `turn-routes.test.ts` over
  the 500-line cap, a `TODO` and two `eslint-disable`s inside the
  wasm-bindgen-generated `apps/web/src/generated/` files (re-emitted by
  the generator on every rebuild), the issue-354 receipt crosswalk
  citation, and the `tokens-sync` + `packages/client ShellApp` test
  failures. Commits use the sanctioned `SKIP_GOVERNANCE=1` escape solely
  because these pre-existing violations block any commit; every violation
  introduced by this work was fixed instead.

## Out of scope

- Blob range streaming (custody.open fully buffers; the fix belongs to the
  storage tier, #405).
- App bundling at publish and the tool-call worker pool (wave 2 of #404).
- brotli on the PWA path (DecompressionStream is gzip-only; the PWA
  negotiates gzip, desktop/native get brotli).
- Real video posters / preview ladder (#405) — placeholders are the
  contract here.

## Verification

```sh
# app-engine (compression, etag cache, bridge, sse) — 328 tests, tsc clean
cd packages/app-engine && bun run typecheck && npx vitest run

# tunnel — 13 tests
cd packages/tunnel && npx vitest run

# rust pool: cargo check + full wasm rebuild
cd apps/web/iroh-wasm && cargo check --target wasm32-unknown-unknown
bash apps/web/scripts/build-iroh-wasm.sh

# PWA end-to-end (rebuilds app-engine+gateway dists first) — 6/6
cd apps/web && bun run e2e

# blueprints (apps + kit + new query-handler tests) — 139 pass
cd packages/blueprints && npx vitest run

# whole-repo gate (root)
npx vitest run
```

- app-engine 328 tests (17 new compression + 9 new static-server) green
  post-split; tunnel 13 green; apps/web typecheck + `vite build` clean and
  the 6-test PWA e2e (including the new cache + gzip specs) green against
  freshly built app-engine/gateway dists.
- Rust: `cargo check --target wasm32-unknown-unknown` clean; full release
  wasm rebuild succeeds; generated bindings regenerated in-tree.
- Blueprints: 139 tests green; `lint-apps` 0 errors / 150 files; the jsdom
  app-boot harness boots all 8 real apps with the modified kit (render +
  consent revoke/re-grant walk). Photos verified on the real browser
  harness at 375 px and desktop widths with screenshots read as ground
  truth: 0 grid originals loaded across normal/thumbless/error paths,
  53/53 images `decoding=async` with dimensions.
- Root suite: 2,920 tests pass; the 2 failing files (`tokens-sync`,
  `packages/client ShellApp`) fail identically on the clean base with all
  wave-1 changes stashed — pre-existing, not introduced here.

## Audit

Three checks on the receipt's fidelity to the work.

- **What changed accurately describes the diff** — PASS: git diff --stat lists 41 files (1642 +, 707 −); receipt lists per-commit files and spot-checks confirm compression.ts negotiates Accept-Encoding (lines 21–26), photos media.js removes makeThumb entirely (8 deleted function + 3 deleted callers), kit.js exports onDataChange with debounce (lines 190–196). File-size splits are structural (static-server.ts 448 lines post-split, web-host.ts 484 lines post-split, both under 500-line cap).

- **Each of the 5 checklist items is realized in the diff** — PASS: Commit 1 (compression.ts exists; compression.test.ts + 17 new tests green), Commit 2 (lib.rs QUIC Connection pool, 6 references to connection cache per diff), Commit 3 (sw.js cache buckets SHELL_CACHE/ASSET_CACHE/BLOB_CACHE + stale-while-revalidate), Commit 4 (media.js makeThumb + setThumbSrc deleted entirely), Commit 5 (kit.js onDataChange + onFocusRefresh + observeWidth, 88-line addition, verified in notes/agenda/tasks/tally/locker/people/docs).

- **Checklist honestly maps the issue's workstreams as wave 1** — PASS: Issue #404 defines 6 workstreams (T/C/R/S/A/I); receipt covers T (QUIC pool, wire compression), C (PWA caching, gzip decode, persist, icons), R (SSE radio discipline, health poll gating), A (photos/notes/agenda/all-apps hygiene + kit helpers); S (bundle apps, worker pool) and I (instrumentation) deferred to wave 2 per "Out of scope" section. Mapping is honest-but-partial, faithful to issue structure without claiming unfinished work.

## Steering

Two checks on mid-task steering events in the session transcript.

- **Every steering event in the session is recorded** — PASS: User messages extracted from transcript (ignoring task-notification blocks). Four user messages: (1) initial audit request "look at our all 8 blueprint apps...", (2) "okay no suggestions for clawgnition...", (3) "okay, this is fine. now let'ts take all you findings...", (4) "create a separate worktree first...act as orchestrator...". None are mid-task interrupts or corrections — all are task requests/approvals at session boundaries. No steering rows needed.

- **No non-steering message is recorded as a steering event** — PASS: The receipt has no "### Steering" table under "## Accounting" yet (no steering rows pre-existing); task-notification blocks are correctly excluded from user-message interpretation.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-4f297cb4-d1d-1784042607-1 | claude-code | 4f297cb4-d1d1-4823-be8d-6087c00b4fc0 | #404 | claude-fable-5 | 244 | 2189690 | 21955487 | 363190 | 2553124 | 67.4886 | 244 | 2189690 | 21955487 | 363190 | perf(app-engine,tunnel): wire compression, ETag memoization, SSE radio disciplin |
| claude-code-4f297cb4-d1d-1784042644-1 | claude-code | 4f297cb4-d1d1-4823-be8d-6087c00b4fc0 | #404 | claude-fable-5 | 8 | 6220 | 1030740 | 2156 | 8384 | 1.2164 | 252 | 2195910 | 22986227 | 365346 | perf(app-engine,tunnel): wire compression, ETag memoization, SSE radio disciplin |
| claude-code-4f297cb4-d1d-1784042765-1 | claude-code | 4f297cb4-d1d1-4823-be8d-6087c00b4fc0 | #404 | claude-fable-5 | 20 | 22660 | 2641360 | 10439 | 33119 | 3.4468 | 272 | 2218570 | 25627587 | 375785 | perf(app-engine,tunnel): wire compression, ETag memoization, SSE radio disciplin |
