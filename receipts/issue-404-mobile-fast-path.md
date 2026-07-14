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

Wave 2 — the rest of the issue's scope:

- [x] Commit 6 — app-engine: serve-time app bundling, hashed immutable assets, inlined CSS
- [x] Commit 7 — app-engine: warm worker pool + bridge read() dedup/abort
- [x] Commit 8 — web: activate wasm-opt, iOS splash images
- [x] Commit 9 — blueprints: optimistic tally add-expense; fix visual-harness vs compression
- [x] Commit 10 — perf: PWA waterfall probe, CI budgets, connect-vs-stream instrumentation

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

### Commit 6 — app-engine: serve-time app bundling, hashed immutable assets, inlined CSS

Files: `packages/app-engine/src/http/app-bundle.ts` (new),
`packages/app-engine/src/http/app-bundle.test.ts` (new),
`packages/app-engine/src/http/static-server.ts`,
`packages/app-engine/src/http/security.ts`,
`packages/app-engine/src/http/asset-variants.ts`.

- Each blueprint app previously loaded as a raw per-file ESM graph (photos:
  41-module boot graph, 3-4 levels deep) plus 4 render-blocking CSS links,
  every file revalidating `private, no-cache` on each boot. Serving a live
  `index.html` now esbuild-bundles the whole local import graph (kit +
  vendored React included) and rewrites the entry `<script type="module">`
  to `./_bundle.<hash>.js`; the app's CSS is inlined into a single
  `<style>` block (CSP already carries `style-src 'unsafe-inline'`; no
  kit/app CSS uses `url()`/`@import`, so base-URL rewriting is not needed).
  A successful rewrite leaves zero external modules, so no modulepreload
  hints are required.
- **Photos: 46 requests → 2** (HTML + bundle). Bundle 439 KB raw /
  **91 KB brotli**, 41 ms cold build, ~1 ms warm. All 8 apps bundle.
- Cache key = manifest of the app's `.js/.jsx/.mjs` tree (rel + mtime +
  size, excluding handler dirs) + shared kit stats; the hashed URL is
  content-addressed and served `max-age=31536000, immutable` with a full
  sha256 ETag, so warm opens never revalidate it and the SW's URL+ETag
  cache stores it permanently. Stale hashes 404 cleanly.
- Resolution parity with the per-file path: esbuild resolves through
  `resolveStaticPath` (escape/reserved guards), per-app copy beats the
  shared dir, root-only shared fallback, `automatic` JSX runtime so a
  single React instance survives. Roots are realpath'd (symlinked
  worktrees would otherwise fail containment).
- **Drafts are exempt everywhere** — the builder's live-editing path keeps
  per-file serving with the depth-aware jsx-runtime climb; `_bundle.*.js`
  404s under `_draft/`. A bundle build failure leaves the tag untouched
  and degrades to exactly the pre-change behavior.
- `SHARED_ASSET_FILES` moved to `security.ts` (leaf module) so the server
  and the bundler share one list without an import cycle.

### Commit 7 — app-engine: warm worker pool + bridge read() dedup/abort

Files: `packages/app-engine/src/handlers/worker-pool.ts` (new),
`packages/app-engine/src/handlers/handler-pool.test.ts` (new),
`packages/app-engine/src/handlers/handler-runner.ts`,
`packages/app-engine/src/worker/runner.ts`,
`packages/app-engine/src/http/bridge-script.ts`,
`packages/app-engine/src/http/bridge-script.test.ts` (new).

- Every tool call spawned a fresh `worker_threads` Worker and terminated
  it. Investigation found the worker loads handler code via dynamic
  `import`, so a worker's module registry accumulates every handler it
  runs — **reuse would leak one app's module-level state into another**.
  The pool therefore keeps workers **single-use** and instead pre-boots
  **warm spares**: N pre-started workers finish thread-start + runner-module
  evaluation and park; `acquire()` hands one out and schedules its
  replacement, so boot cost is paid off the request's critical path.
  Isolation is byte-for-byte identical to the old model (a handler still
  executes in a thread that imported no other handler) — only the spawn
  moves earlier in time.
- Dispatch latency (50 sequential reads): **~84 ms → ~29-35 ms** at the
  default pool size (~2.8x); size 0 reproduces the old path exactly.
  Config `CENTRAID_WORKER_POOL_SIZE` (default 2, clamp 0-8). Timeout kill,
  crash survival, and the #351 admission gate all preserved.
- **Bridge `read()`**: identical concurrent `(query, input)` calls now share
  one in-flight fetch; `{signal}` is supported and the returned promise
  carries `.abort()`. The shared fetch aborts only when *every* sharer has
  aborted (ref-counted) — one caller cancelling rejects only itself.
  `write()` is never deduped but passes `{signal}` through. Purely
  additive; the `read({query,input})` / `write({action,input})` contract is
  unchanged.

### Commit 8 — web: activate wasm-opt, iOS splash images

Files: `apps/web/scripts/build-iroh-wasm.sh`,
`apps/web/src/generated/centraid_web_iroh_bg.wasm`,
`apps/web/index.html`,
`apps/web/public/splash-*.png` (6 new).

- Installed binaryen and fixed the `wasm-opt` invocation — it needs
  `--all-features` (the bindgen output uses bulk-memory/reference-types;
  without the flag wasm-opt rejects the module). The pass is now live:
  the WASM the phone downloads and compiles drops **2,182,419 →
  1,982,399 bytes (-9.2 %)**.
- iOS PWAs launched to a white flash with no startup images. Six portrait
  splash PNGs (1290x2796, 1179x2556, 1170x2532, 1125x2436, 828x1792,
  750x1334) on the manifest's `#111317` background with the centered mark,
  palette-quantized to **40 KB total**, wired via media-queried
  `apple-touch-startup-image` links.

### Commit 9 — blueprints: optimistic tally add-expense; fix visual-harness vs compression

Files: `packages/blueprints/apps/tally/logic.js`,
`packages/blueprints/apps/tally/app.jsx`,
`packages/blueprints/apps/tally/components/ExpenseRow.jsx`,
`packages/blueprints/visual-harness/server.mjs`,
`packages/blueprints/visual-harness/mock-centraid.js`.

- **Tally add-expense is optimistic**: the decorated row lands in a pending
  overlay and the ledger + dashboard totals repaint with the shared kit
  pending chip *before* the write resolves; the modal closes immediately.
  Reconcile: executed → doorbell refresh clears the overlay only once the
  refresh lands (no blink-out); parked → row keeps the chip, is excluded
  from dashboard totals (a parked write moved no balance) and shows the
  existing approval banner; failed/denied → row is removed with the
  existing error narration. **Critical path 2 serial RTTs → 0.**
  Edit-expense stays cold-path; settle-up/add-friend are deliberately not
  converted (settle nets balances, add-friend has no party id until the
  server mints one).
- **Visual-harness regression fixed** (introduced by wave 1's compression):
  `serveAppAsset` captured `serveStatic`'s output and did
  `body.toString('utf8')` to inject the mock — but with a browser's
  `Accept-Encoding` that body is now brotli, so the text conversion
  corrupted it into replacement chars while `Content-Encoding: br` was
  passed through, and every harness page died with
  `ERR_CONTENT_DECODING_FAILED`. The harness re-encodes nothing, so it now
  asks `serveStatic` for identity bytes. Also corrected the mock's change
  feed to fire `tables: []` (what the real runtime emits for an app's own
  handler writes, and what the kit's table filter always lets through)
  instead of a bare app id, and refreshed its stale "neither app registers
  a listener" comment — seven apps subscribe through the kit now.

### Commit 10 — perf: PWA waterfall probe, CI budgets, connect-vs-stream instrumentation

Files: `apps/web/tests/e2e/perf-waterfall.spec.ts` (new),
`apps/web/tests/e2e/perf-budgets.ts` (new),
`apps/web/src/iroh-transport.ts`,
`scripts/perf/run-waterfall.mjs` (new),
`scripts/perf/summarize.mjs` (new),
`scripts/perf/README.md` (new).

- The committed waterfall probe only ever measured Electron — the surface
  that benefits most from the HTTP cache and least from our work. A PWA
  probe now runs on the real e2e harness (shell + app iframe, cold and
  warm), emits a JSON report, and asserts budgets from a single documented
  module: request-count and transfer-byte ceilings (measured + 20 %
  headroom) and warm/cold ratios. Timing budgets ship **soft/log-only**
  until CI proves stable; a `>0 bytes` guard stops a silently-warm run from
  passing as a cold one.
- **Transport instrumentation proves the wave-1 pool**: `__centraidIrohStats`
  ({connects, streams, reconnects}) plus `centraid:iroh-connect` /
  `centraid:iroh-request` User Timing marks. Live measurement in headless
  Chromium: **1 connect / 12 streams** (ratio 0.08) — before the pool this
  was one connect per request. SW tunnel cache measured cold
  `calls=2, bytes=12288` → warm `calls=1, bytes=0`.
- The spec auto-runs under the existing `apps/web` e2e script (shared
  Playwright `testDir`); `node scripts/perf/run-waterfall.mjs` runs it
  standalone. **CI gap flagged, not closed:** the repo has no web-e2e job
  at all today (`e2e.yml` runs only the nightly desktop suite), so the
  budgets do not gate CI until that job exists — the exact workflow steps
  are recorded in `scripts/perf/README.md`.

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
- **`wasm-opt` now active** (wave 2): binaryen installed and the
  invocation fixed with `--all-features` — the bindgen output uses
  post-MVP features and wasm-opt rejects the module without it. -9.2 %.
- **File-size cap compliance by extraction**: `static-server.ts` and
  `web-host.ts` crossed 500 lines from legitimate additions; both were
  split mechanically (asset-variants/bridge-script, sw-lifecycle/
  connectivity) rather than waived.
- **Worker pool keeps workers single-use** (wave 2): handler code loads via
  dynamic `import`, so reusing a worker would let one app's module-level
  state leak into another's run. Chose warm-spare pre-booting (same
  isolation, boot cost off the critical path) over pooled reuse — the
  latency win is nearly identical and the isolation semantics are
  unchanged. Correctness over the last few milliseconds.
- **Bundling applies to installed apps only** (wave 2): drafts keep per-file
  serving so the builder's live editing keeps working, and a bundle build
  failure degrades to the per-file path rather than failing the request.
- **CSS inlined rather than concatenated** (wave 2): the CSP already allows
  `style-src 'unsafe-inline'` and no kit/app CSS uses `url()`/`@import`, so
  inlining is base-URL-safe and removes the last 4 render-blocking round
  trips. Cost: ~12 KB brotli added to each (no-store) HTML response.
- **Perf budgets do not gate CI yet** (wave 2): the repo has no web-e2e job;
  the spec and budgets are in place and run locally / in the `apps/web` e2e
  script, and the workflow steps needed are documented. Adding a CI job is
  a repo-infra change left to the owner.
- **Visual-harness regression was ours** (wave 2): wave 1's compression broke
  every real-browser harness page (`ERR_CONTENT_DECODING_FAILED`). Fixed
  here rather than deferred, since the harness is the verification surface
  for the blueprint apps. All 8 apps re-verified in real Chromium.
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

# wave 2: PWA perf probe standalone (waterfall + budgets + pool proof)
node scripts/perf/run-waterfall.mjs

# wave 2: visual harness in a real browser (all 8 apps must load clean)
bun packages/blueprints/visual-harness/server.mjs   # then open /centraid/<app>/

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
- Wave 2: app-engine **355 tests** green (12 new bundling + 6 pool + 9
  bridge); apps/web e2e **9/9** (6 original + 3 new perf specs); blueprints
  139 green; typecheck clean across app-engine, apps/web, blueprints.
- Wave 2 measurements: photos app open **46 → 2 requests** (bundle 91 KB
  brotli); handler dispatch **~84 ms → ~29-35 ms**; iroh **1 connect /
  12 streams** (pool reuse proven live in headless Chromium); SW warm open
  **0 bytes**; wasm **2,182,419 → 1,982,399 bytes**.
- Visual harness re-verified in real Chromium after the compression fix:
  all 8 apps reach `readyState: complete` with **zero console errors**
  (photos renders 759 nodes through the new bundle URL, so the bundling
  path is browser-verified end to end). Tally's optimistic flow verified on
  the harness at 375x812 across executed/parked/failed with screenshots
  read as ground truth.
- Root suite: **2,947 tests pass**; the 2 failing files (`tokens-sync`,
  `packages/client ShellApp`) fail identically on the clean base with all
  changes stashed — pre-existing, not introduced here.

## Audit

Three checks on the receipt's fidelity to the full 10-commit work (waves 1–2).

- **What changed accurately describes the diff across both waves** — PASS: Wave 1 git diff lists 41 files (1642 +, 707 −); wave 2 working tree shows 16 new files (splash PNGs, perf specs, bundle/pool/bridge helpers) + 15 modified files. Receipt lists per-commit files and spot-checks confirm compression.ts negotiates Accept-Encoding (wave 1, lines 21–26), photos media.js removes makeThumb entirely (wave 1), kit.js exports onDataChange/onFocusRefresh/observeWidth (wave 1, lines 255–293), app-bundle.ts esbuild-bundles apps (wave 2, exists + mentioned), worker-pool.ts keeps workers single-use with warm spares (wave 2, exists), wasm-opt invoked with --all-features (wave 2, scripts/build-iroh-wasm.sh line 33), splash-*.png (6 files) exist, perf-waterfall.spec.ts and perf-budgets.ts exist. File-size splits are structural (static-server.ts 448 lines, web-host.ts 484 lines post-split, both under cap).

- **Each of the 10 checklist items is realized in the working tree** — PASS: Commits 1–5 (wave 1) committed; commits 6–10 (wave 2) staged/modified. Commit 1 (compression.ts + 17 tests), Commit 2 (QUIC Connection pool caching), Commit 3 (sw.js SHELL_CACHE/ASSET_CACHE/BLOB_CACHE + stale-while-revalidate), Commit 4 (photos makeThumb + setThumbSrc deleted), Commit 5 (kit.js 88-line addition to 7 apps), Commit 6 (app-bundle.ts creates hashed immutable bundles, 46→2 requests verified), Commit 7 (worker-pool.ts single-use with warm spares + bridge-script.ts read() dedup/AbortController), Commit 8 (wasm-opt -Oz --all-features + 6 splash PNGs), Commit 9 (tally optimistic logic + visual-harness compression fix), Commit 10 (perf-waterfall.spec.ts + perf-budgets.ts + instrumentation marks).

- **Checklist covers all issue workstreams; deferred items honestly disclosed** — PASS: Issue #404 defines T/C/R/S/A/I. Receipt covers T (compression, QUIC pool, wasm-opt), C (PWA cache, gzip decode, splash, persist), R (SSE radio discipline, health poll gating), S (app bundling, worker pool, eTag cache), A (photos/notes/agenda/all-apps hygiene), I (PWA perf waterfall probe + CI budgets). The receipt openly discloses that "the repo has no web-e2e job at all today... the budgets do not gate CI until that job exists" (line 374–377) — the instrumentation is complete and landing, but CI integration is deferred, not claimed done. Mapping is comprehensive across all workstreams; no claimed items are actually deferred.

## Steering

Two checks on mid-task steering events in the session transcript.

- **Every steering event in the session is recorded** — PASS: User messages extracted from transcript (ignoring task-notification and goal-hook blocks). One genuine mid-task correction identified and recorded: the visual-harness regression report (ordinal 669, 2026-07-14T16:16:19.714Z). User reported that wave 1's compression broke every real-browser harness page with `ERR_CONTENT_DECODING_FAILED`, provided root cause (CaptureResponse's `body.toString('utf8')` corrupts brotli/gzip), reproduction, and fix options. This correction redirected the agent to fix it as part of Commit 9. Row recorded in the Steering table below.

- **No non-steering message is recorded as a steering event** — PASS: The "### Steering" table under "## Accounting" is empty (no pre-existing rows); task-notification blocks and goal-setting commands are correctly excluded from steering-event interpretation.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-4f297cb4-d1d-1784042607-1 | claude-code | 4f297cb4-d1d1-4823-be8d-6087c00b4fc0 | #404 | claude-fable-5 | 244 | 2189690 | 21955487 | 363190 | 2553124 | 67.4886 | 244 | 2189690 | 21955487 | 363190 | perf(app-engine,tunnel): wire compression, ETag memoization, SSE radio disciplin |
| claude-code-4f297cb4-d1d-1784042644-1 | claude-code | 4f297cb4-d1d1-4823-be8d-6087c00b4fc0 | #404 | claude-fable-5 | 8 | 6220 | 1030740 | 2156 | 8384 | 1.2164 | 252 | 2195910 | 22986227 | 365346 | perf(app-engine,tunnel): wire compression, ETag memoization, SSE radio disciplin |
| claude-code-4f297cb4-d1d-1784042765-1 | claude-code | 4f297cb4-d1d1-4823-be8d-6087c00b4fc0 | #404 | claude-fable-5 | 20 | 22660 | 2641360 | 10439 | 33119 | 3.4468 | 272 | 2218570 | 25627587 | 375785 | perf(app-engine,tunnel): wire compression, ETag memoization, SSE radio disciplin |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-4f297cb4-1-1 | 4f297cb4-d1d1-4823-be8d-6087c00b4fc0 | #404 | correction | classifier | Wave 1 compression broke harness; needs fix | perf(blueprints): tally + harness fix | 669 | 2026-07-14T16:16:19.714Z |
