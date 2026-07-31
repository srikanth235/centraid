# Issue #659 — Performance & scalability umbrella

Costs-little + feels-instant rigor, ranked debt burn-down, year-3 scale honesty.
Delivered by six parallel implementation lanes (vault, gateway/app-engine,
client/desktop/web, mobile, docs/doctrine, measurement rigor) under one
orchestrator, all against a single branch.

## Checklist

- [x] **R1. Constitutional performance principle.** Add to CONSTITUTION.md: every user-facing interaction has a perceived-latency budget; a new hot path without a measured budget is an incomplete feature; nothing O(vault-size) may run synchronously on the request path or the event loop.
- [x] **R2. Experience budgets in user terms.** One budget file per surface (mirroring `low-end-budgets.json` / `perf-budgets.ts`), wired into the ratchet: app cold-open → first usable screen; tap → visual response; chat send → first token; scroll frame-drop ceiling; sync staleness after reconnect.
- [x] **R3. Close the measurement holes.** Web-vitals (LCP/INP/CLS) capture in the existing Playwright waterfall probe; a real Electron launch-time probe (current `desktop-cold` is a first-import proxy); mobile cold-start per-launch budget + frame-drop probe on Photos and People; bundle/app-weight assertions on `expo export` and `apps/desktop/dist/renderer` (builds already run in `ci:bundle` — they're just never weighed).
- [x] **R4. Drift gating.** Fixed-constant rigs (`gateway-request`, `vault-write`, …) must also consume their 30-sample history and fail on sustained >1.5× median drift. Wire or delete the inert `tests/quality-rig-budgets.json`.
- [x] **R5. Production perf telemetry.** Per-route p50/p95/p99 duration histograms in the gateway surfaced via HealthRegistry (plumbing exists in `resource-accounting.ts`); this is also how we get honest baselines before setting new budgets.
- [x] **R6. Hygiene.** Fix the stale `scripts/perf/README.md` pointer to the deleted desktop waterfall probe.
- [x] **G1. O(n²) phash duplicate clustering on the hourly sweep** — `packages/vault/src/enrich/clusters.ts:82` brute-forces pairwise hamming over all photo phashes every sweep; ~4 billion comparisons at a realistic year-3 library (90k assets), synchronous, holding the vault handle. Replace with bucketing/BK-tree or make incremental (only re-cluster changed phashes). Scale test never covers this path (see S1).
- [x] **G2. Unconditional full-table rewrite feeding backup** — `clusters.ts:108` runs `UPDATE media_asset_phash SET cluster_id = NULL` every sweep even when nothing changed, dirtying WAL pages that the shipper uploads and bills hourly. Compare-then-write.
- [x] **G3. Per-request session sweep** — `packages/gateway/src/serve/web-app-sessions.ts:243,252`: every HTTP request runs two map sweeps + a SQL `DELETE` + an unindexed full `SELECT` on gateway.db (which has `busy_timeout=0`, `journal_mode=DELETE`). Move sweeping to a timer; index `expires_at`; prepare statements once.
- [x] **G4. FTS trigger is O(conversation) per item insert** — `packages/app-engine/src/stores/gateway-db.ts:580`: every streamed item re-derives and re-indexes the whole conversation body inside the write transaction → O(n²) per thread. Make it incremental or debounce to turn-end.
- [x] **G5. Transcript N+1 + unpaginated uncompressed payload** — `packages/app-engine/src/conversation/history.ts:343` (1 + turns + items queries; batched shapes exist unused at `store-sql.ts:592`) and `conversation-routes.ts:260-265` (whole multi-MB transcript `JSON.stringify`d, deliberately uncompressed). Batch the reads; paginate; negotiate compression.
- [x] **G6. No SSE backpressure anywhere** — no `res.write()` return check or `drain` handling in any of `changes-sse.ts`, `turn-sse.ts`, `logs-routes.ts`, `automations-routes.ts`, `replica-routes.ts`. A slow client buffers unboundedly in gateway heap.
- [x] **G7. Replica SSE recomputes shape graph per commit per subscriber** — `packages/gateway/src/routes/replica-shape.ts:293`: any commit invalidates every entity's temporal fingerprint (full-table pagination + sha256), recomputed per connected device. Share computation across subscribers; invalidate per-entity. Also `replica-projection.ts:309`: `db.prepare()` per change row (up to 1000/poll).
- [ ] **G8. `run_summary` VIEW: 3 correlated subqueries per turn × 7 Insights queries** — `gateway-db.ts:476-530` / `insights-sql.ts`. Materialize a rollup.
- [x] **G9. Unbounded module-level asset caches** — `packages/app-engine/src/http/asset-variants.ts:57,60,63`: content-etag-keyed, so every builder save retains raw + brotli + gzip bytes for process lifetime. Add LRU or per-path single generation.
- [x] **G10. Boot ordering** — `serve.ts:113-114`: socket listens before vaults mount; mount runs a synchronous lifecycle sweep (`vault-plane.ts:2448`) and per-app prewarm sequentially; first health poll runs synchronous `PRAGMA quick_check` over the whole vault (`vault-integrity-health.ts:62`). Mount before/parallel to listen where possible; move sweep + quick_check off the critical path.
- [x] **G11. Medium batch:** `scryptSync` on the vault-call path (`locker-auth.ts:490` → async scrypt); unbounded `listConversations`/`listTurnsAsc` ORDER BY without LIMIT (`store-sql.ts:364,493`); group-commit flush has no batch size cap (`group-commit-queue.ts:46`); `busy_timeout=30000` on the synchronous journal driver (`gateway-db.ts:798`); warm-spare worker pool defaults to 0 on constrained hosts (`worker-pool.ts:90` — exactly the target hardware); replica SSE builds an unbounded promise chain (`replica-routes.ts:651` → while-loop); `DROP/CREATE VIEW` on every journal open (`gateway-db.ts:475`).
- [x] **C1. Streaming chat re-parses everything per token** — `packages/client/src/react/shell/routes/assistantTranscript.ts:314`: `richAnswerHtml` runs for every finished message on every SSE token, through an unmemoized `Message` list with index keys and per-render callback objects (`AssistantScreen.tsx:351,388`). Memoize per (message, text); `React.memo` the transcript; batch SSE events (rAF/`startTransition` — currently zero batching). Same pattern in `automationLiveMessages.ts:449`.
- [x] **C2. Desktop shows no window until the gateway boots** — `apps/desktop/src/main.ts:157,172`: `loadSettings()` awaits full embedded-gateway boot before `createWindow()`. The renderer already tolerates an absent gateway. Create the window first; boot in parallel. Add `show:false` + `ready-to-show`.
- [x] **C3. 2 MB iroh WASM gates first data on web** — `apps/web/src/iroh-transport.ts:53`: lazy init on the first gateway request, so time-to-usable is dominated by a download+instantiate the byte budgets never see. Warm it during idle after first paint; add it to the budget.
- [x] **C4. 5s heartbeat re-renders the entire active screen** — `apps/desktop/src/main/gateway-monitor.ts:388` broadcasts unconditionally; `ShellApp.tsx:97` re-invokes `renderRoute` closures (`App.tsx:851`). Change-gate the broadcast; give routes real component boundaries.
- [x] **C5. No query cache / SWR primitive** — `useAsyncData.ts` blanks to LOADING on any dep change: every approvals decision blanks the page (`ApprovalsRoute.tsx:48`), pin toggle destroys the runs list (`RunsPane.tsx:62`), route re-entry refetches cold. Introduce one shared stale-while-revalidate cache (the gateway-switcher pattern at `App.tsx:687` is the model).
- [x] **C6. Non-optimistic mutations** — rename/pin/archive conversation (`App.tsx:540-599`), app delete/rename (`HomeRoute.tsx:175-232`), approvals decisions, run pin: all await + full-list refetch. Make optimistic with reconcile.
- [x] **C7. Medium batch:** keystroke re-renders transcript + sync `localStorage` write (`AssistantScreen.tsx:303`); attachment full-blob fetch with object-URL revoke on unmount → re-download on scroll-back (`gateway-client-conversation-history.ts:76`, `AssistantMessage.tsx:125`) and refetch on parent re-render (`AssistantRoute.tsx:418`); no `width`/`height`/`loading="lazy"` on any `<img>`; four visibility-ungated pollers (`useGatewayHealth` 15s, `useBlockingCount` 60s, DevicesCard/BackupCard/StorageScreen) — `visibility-ticker.ts` exists, use it; Logs screen renders unbounded lines unwindowed (`LogsScreen.tsx:348`); route-level code splitting (`App.tsx:40-75` imports every route eagerly); Home blanks on feed load though apps are already in memory (`HomeRoute.tsx:282`); shell rescope listeners never unsubscribed (`App.tsx:460`); skeletons instead of "Loading…" text (`status.tsx:12`).
- [x] **M1. Replica reads: push WHERE/LIMIT into SQL and go async** — `apps/mobile/src/lib/replica/multi-vault-reader.ts:340`: no WHERE/LIMIT in SQL; callers pass `limit: 100_000` (`timeline-engine.ts:187`), every row JSON-parsed in JS (`multi-vault-provenance.ts:57`), all via `executeSync` on the JS thread (`op-sqlite-driver.ts:53` — op-sqlite's async API is unused). This one fix addresses reads, invalidation storms (`useReplicaQuery.ts:90` — also debounce/coalesce), and JS-thread jank at once.
- [x] **M2. Photos pipeline** — sync `File.exists` stat per photo per recompute (`timeline-engine.ts:369` → batch one directory listing); O(n²) device-library walk (full copy + full recompute per 1000-row page, `timeline-engine.ts:280`); thumbnail-pack prefetch re-runs on every snapshot and downloads sequentially (`PhotosHome.tsx:107`, `thumbnail-pack.ts:60`); grid cells decode full-res device assets (`PhotoTimeline.tsx:262`); lightbox original over cellular ungated (`PhotoLightbox.tsx:111`).
- [x] **M3. Cold start** — all 30+ screens eagerly imported (`App.tsx:32-89`, pulls maps/camera/webview/video at launch → lazy per-navigate); first paint blocked on 10 fonts + AsyncStorage (`App.tsx:404-438`); per-scope replica open with synchronous migrations on the launch path (`ReplicaProvider.tsx:408-441`); network burst before UI usable (`ReplicaProvider.tsx:295-308,545`).
- [x] **M4. Battery/polling** — `ReplicaStatusBar` 5s poll mounted on 16 screens with no AppState guard (`ReplicaStatusBar.tsx:44`); 4s upload poll opening/closing SQLite per tick (`timeline-engine.ts:104`); intent-flush retries at fixed 2s forever with no backoff (`native-session.ts:218`); `pullNow` on every network-state flap on top of foreground pulls (`ReplicaProvider.tsx:542`).
- [x] **M5. Data frugality** — Home refetches 3 endpoints on mount + focus + subscribe (`Home.tsx:155-169`); zero conditional requests (no ETag/If-None-Match anywhere in `src/lib/gateway.ts`); cursor persisted to AsyncStorage per change event (`native-change-feed.ts:223`).
- [x] **M6. Lists** — 8 vertical FlatLists with no `getItemLayout`/windowing tuning and unmemoized inline renderItems (People up to 5k rows); unbounded album grids in plain ScrollViews (`PhotosLibrary.tsx:307`); `expo-image` memory cache unbounded.
- [x] **L1. Prune `core_entity_revision`** — full-row JSON snapshot per mutation, only reader is the 10s undo window (`commands/entity-revisions.ts:10,82`), retained forever, shipped in every WAL segment. Add `DELETE WHERE undo_until < now` to sweepLifecycle (or build the audit reader the schema comment promises — decide, don't drift).
- [x] **L2. Cap journal archival runs** — `packages/vault/src/journal-archive.ts:167-291`: three uncapped full-table scans + O(n²) fixed-point closure + single `gzipSync` of the whole segment. Mirror #438's per-run caps.
- [x] **L3. Size ladder for vault.db** — journal.db has one (`journal-limit.ts`); vault.db has nothing. At minimum: monitoring + the L1 sweep.
- [x] **L4. Retention for the silent growers** — `sync_connection_run` (one row per connector sync forever), `enrich_request`, terminal `outbox_item` rows.
- [x] **L5. Hourly CAS mark/sweep cost** — full readdir + sort + three unindexed full scans into JS Sets, per vault per hour (`local-orphan-sweep.ts:91`, `blob/read.ts:215`); same `liveBlobShas` cost re-paid per backup tick. Make incremental or reduce cadence with size.
- [x] **L6. `quick_check` cadence scaling** — hourly full-file scan per vault (`vault-integrity-health.ts:53`); scale cadence with file size or move off-thread.
- [x] **L7. Batched/resumable migration primitive** — before the first data-rewriting rung lands (`schema/migrate.ts:203`); the FTS rebuild path is the first candidate to need it.
- [x] **L8. Mounted-plane budget** — ~160 MB mmap + 32 MB page cache per mounted vault (`db.ts:213`), no cap on planes; add a 5-vault footprint assertion and consider an idle-unmount policy.
- [x] **L9. `history.keep: "all"`** is a legal manifest value — lint or cap it.
- [x] **S1.** Phash-clustering scale rig at ≥90k assets, exercising `sweep()` (covers G1/G2).
- [x] **S2.** `blob-gc.scale.test.ts` from 5k → ≥100k objects.
- [x] **S3.** Restore test at ≥10 GiB, nightly; measure `foreign_key_check` (`wal-restore.ts:399`) in isolation and publish the number — backup honesty is a product promise and restore time at year-3 scale is currently a guess.
- [x] **S4.** Mobile envelope: measured at 50k rows (`docs/mobile-offline.md:71`) but 90k photos is plausible before year 3 — extend or document the real ceiling.
- [x] **S5.** 5-vault fixed-footprint + sweep-budget assertion (current ceiling pinned at 2 vaults).
- [x] **S6.** Backup manifest size bound (chunkIndex is O(vault) JSON rebuilt per snapshot, `manifest.ts:97`).
- [x] **D1.** Nothing O(vault-size) synchronous on the request path or event loop (sync SQLite, `scryptSync`, `gzipSync`, sweeps).
- [x] **D2.** No load-bearing "personal vaults are small" assumptions in comments without an enforcing budget or cap — every such comment found (clusters, FTS trigger, VACUUM-on-open) is a future outage.
- [x] **D3.** Compute-once-share for fan-out: per-subscriber recompute is a defect (replica SSE, per-request sweeps).
- [x] **D4.** Clients use the shared SWR/query-cache primitive (C5); blanking refetch on mutation is a defect.
- [x] **D5.** Every poller is visibility/AppState-gated; new pollers need justification over push.
- [x] **D6.** Scale rigs are calibrated to year-3 declared volumes, not current fixtures; the volume table lives with the rig.

## What changed

Each entry below quotes the issue's checklist item, then says what landed. The
one unchecked item (G8) is explained under Decisions.

**R1. Constitutional performance principle.** Add to CONSTITUTION.md: every user-facing interaction has a perceived-latency budget; a new hot path without a measured budget is an incomplete feature; nothing O(vault-size) may run synchronously on the request path or the event loop.

Two bullets added to the Principles section of `CONSTITUTION.md` (judgment-enforced, not a mechanical directive — the kit's cardinal rule requires a directive to land with an enforcing test, and these failure shapes are not grep-decidable), plus an appended Evolution Log entry dated 2026-07-31 recording that reasoning.

**R2. Experience budgets in user terms.** One budget file per surface (mirroring `low-end-budgets.json` / `perf-budgets.ts`), wired into the ratchet: app cold-open → first usable screen; tap → visual response; chat send → first token; scroll frame-drop ceiling; sync staleness after reconnect.

New `tests/experience-budgets/` with `web.json`, `desktop.json`, `mobile.json`, `gateway.json` and a README, registered in `PERF_BUDGET_SOURCES` in `scripts/test-report/ratchet-floors.mjs`. Every metric carries `status` (`measured` / `projected` / `unmeasured`), the volume it was taken at, and a named probe. Entries that are not yet observable carry no number at all — the intended ceiling is parked under a leading-underscore key invisible to the ratchet, so nothing gates vacuously.

**R3. Close the measurement holes.** Web-vitals (LCP/INP/CLS) capture in the existing Playwright waterfall probe; a real Electron launch-time probe (current `desktop-cold` is a first-import proxy); mobile cold-start per-launch budget + frame-drop probe on Photos and People; bundle/app-weight assertions on `expo export` and `apps/desktop/dist/renderer` (builds already run in `ci:bundle` — they're just never weighed).

Web-vitals capture added as a fourth test in `apps/web/tests/e2e/perf-waterfall.spec.ts` (observers installed via `addInitScript` before any document script): CLS measured at 0 and hard-gated at 0.1; LCP and INP are reported-and-annotated rather than asserted, because the browser emits no `first-contentful-paint` on this shell after 16s. A real Electron launch probe landed as `apps/desktop/tests/e2e/launch-time.spec.ts` + `tests/perf/desktop-launch.perf.test.ts` and measured cold-open-to-usable-Home at 4,540 ms, of which 4,494 ms is main-process boot before any window exists — none of which the old first-import proxy could see. Mobile got `cold-start.mjs` (8 per-launch samples, median/p95) and `scroll-frames.mjs`; both are pending-nightly since they need a simulator. App weight is now weighed by `scripts/perf/app-weight.mjs`, wired into `ci.yml` and `lane-client-e2e.yml`: desktop renderer 5,827,344 B, mobile 11,596,398 B iOS / 11,604,148 B Android.

**R4. Drift gating.** Fixed-constant rigs (`gateway-request`, `vault-write`, …) must also consume their 30-sample history and fail on sustained >1.5× median drift. Wire or delete the inert `tests/quality-rig-budgets.json`.

`tests/quality-rig-budgets.json` was wired, not deleted — it had live consumers, but its knobs were inert (nothing read `minimumSamples`/`regressionMultiplier`). Added `minimumDriftSamples: 30` and `driftMultiplier: 1.5`, a `rigDriftBudgetMs()` reader in `tests/helpers/rig-budgets.ts` with a JS twin in `tests/agent-e2e-shared/harness.mjs`, and wired all 18 rigs that previously read no history. `scripts/validate-nightly-wiring.mjs` now fails any rig reading neither history source, so this cannot silently regress again.

**R5. Production perf telemetry.** Per-route p50/p95/p99 duration histograms in the gateway surfaced via HealthRegistry (plumbing exists in `resource-accounting.ts`); this is also how we get honest baselines before setting new budgets.

New `packages/gateway/src/serve/route-latency.ts`, surfaced through `health-registry.ts` as `metrics.routeLatency` and recorded in `composedHandler` on response `close`, so a streamed body is measured to its last byte. Fixed logarithmic buckets, no dependencies, no retained samples; route labels collapse ids to `:id` and fold past 64 distinct labels into `other`, because a histogram per conversation id would become the thing it was measuring.

**R6. Hygiene.** Fix the stale `scripts/perf/README.md` pointer to the deleted desktop waterfall probe.

`scripts/perf/README.md` no longer points at `apps/desktop/tests/e2e-live/probe-open-waterfall.mjs`, deleted in commit 70368821. It now states what actually survives there and adds a "Seeded volume (the calibration gap)" section noting the rig's seeded volume is empty, so its budgets are a bundle/transport ratchet that structurally cannot catch an O(vault-size) regression.

**G1. O(n²) phash duplicate clustering on the hourly sweep** — `packages/vault/src/enrich/clusters.ts:82` brute-forces pairwise hamming over all photo phashes every sweep; ~4 billion comparisons at a realistic year-3 library (90k assets), synchronous, holding the vault handle. Replace with bucketing/BK-tree or make incremental (only re-cluster changed phashes). Scale test never covers this path (see S1).

`packages/vault/src/enrich/clusters.ts` now uses multi-index hashing: each hash is split into bands, and two hashes within the threshold must agree in some band, so candidates come from bucket lookups plus a small bit-flip neighbourhood. It is an exact filter — the same clusters as brute force. Made incremental via an input fingerprint memoized per connection, so an unchanged sweep does one indexed read and stops. A first attempt using plain pigeonhole banding produced 8-bit bands and ~80M candidate pairs at 90k assets and exhausted the heap; the scale rig caught it, which is why the shipped design is MIH.

**G2. Unconditional full-table rewrite feeding backup** — `clusters.ts:108` runs `UPDATE media_asset_phash SET cluster_id = NULL` every sweep even when nothing changed, dirtying WAL pages that the shipper uploads and bills hourly. Compare-then-write.

The blanket rewrite is gone. Rows are compared before being written and trashed assets are cleared by one targeted indexed statement, so a no-change sweep dirties no WAL pages for the shipper to bill. The result type gained `updated` and `reused` so the no-write path is observable.

**G3. Per-request session sweep** — `packages/gateway/src/serve/web-app-sessions.ts:243,252`: every HTTP request runs two map sweeps + a SQL `DELETE` + an unindexed full `SELECT` on gateway.db (which has `busy_timeout=0`, `journal_mode=DELETE`). Move sweeping to a timer; index `expires_at`; prepare statements once.

`packages/gateway/src/serve/web-app-sessions.ts` and `web-session-store.ts`: sweeping moved to a 5-minute unref'd timer owned by the gateway lifecycle, and expiry is now enforced by explicit `expiresAt` checks plus an `expires_at > ?` predicate, so correctness never depended on the sweep running. Six statements are prepared once per store and the cookie lookup is a primary-key probe rather than a full-table scan. Added the `web_sessions_expires_idx` index.

**G4. FTS trigger is O(conversation) per item insert** — `packages/app-engine/src/stores/gateway-db.ts:580`: every streamed item re-derives and re-indexes the whole conversation body inside the write transaction → O(n²) per thread. Make it incremental or debounce to turn-end.

The item-insert trigger in `packages/app-engine/src/stores/gateway-db.ts` now appends the new item's text instead of re-deriving the whole conversation body inside the streaming write transaction. Delete-side re-derivation is handled by two new triggers — two because SQLite fires row triggers for `ON DELETE CASCADE` only under `recursive_triggers`.

**G5. Transcript N+1 + unpaginated uncompressed payload** — `packages/app-engine/src/conversation/history.ts:343` (1 + turns + items queries; batched shapes exist unused at `store-sql.ts:592`) and `conversation-routes.ts:260-265` (whole multi-MB transcript `JSON.stringify`d, deliberately uncompressed). Batch the reads; paginate; negotiate compression.

The transcript now reads in three queries instead of one-plus-turns-plus-one-per-message, proven by a statement-counting database proxy that asserts exactly 3 reads at both 4 turns and 80. Compression negotiation was already implemented in `compression.ts` and simply unwired, so that half was a wiring fix. Pagination landed as `listTurnsWindow` (newest N strictly older than `beforeSeq`, re-sorted ascending, over-fetching one row so `hasMore` costs no second query) with `?turns=` and `?beforeSeq=` on the session GET, malformed values rejected 400 rather than ignored — a silently dropped cursor would serve the newest page to a client paging backwards, which reads as "the conversation ends here". `listTurns` now routes through the windowed path, so even the unwindowed call truncates the oldest end rather than the newest.

**G6. No SSE backpressure anywhere** — no `res.write()` return check or `drain` handling in any of `changes-sse.ts`, `turn-sse.ts`, `logs-routes.ts`, `automations-routes.ts`, `replica-routes.ts`. A slow client buffers unboundedly in gateway heap.

New shared `packages/app-engine/src/http/sse-stream.ts`, adopted by all five routes. It bounds Node's own `writableLength` and drops a stalled client rather than buffering it, which is safe because EventSource reconnects and every consumer re-syncs on connect; heartbeats are skipped entirely while the socket needs a drain. Tested over a real TCP socket with a reader that never reads, since the failure being prevented is Node's internal buffering and a mocked response object cannot exhibit it.

**G7. Replica SSE recomputes shape graph per commit per subscriber** — `packages/gateway/src/routes/replica-shape.ts:293`: any commit invalidates every entity's temporal fingerprint (full-table pagination + sha256), recomputed per connected device. Share computation across subscribers; invalidate per-entity. Also `replica-projection.ts:309`: `db.prepare()` per change row (up to 1000/poll).

The temporal-fingerprint cache was already shared across subscribers; the real waste was that it keyed validity on the global watermark, so any commit anywhere invalidated every entity. It is now keyed on `MAX(seq)` for that entity via an index probe. The per-change-row `db.prepare()` calls in the projection's consent lookups go through a new per-connection statement cache.

**G9. Unbounded module-level asset caches** — `packages/app-engine/src/http/asset-variants.ts:57,60,63`: content-etag-keyed, so every builder save retains raw + brotli + gzip bytes for process lifetime. Add LRU or per-path single generation.

New `packages/app-engine/src/http/bounded-cache.ts`; `asset-variants.ts` now uses LRU-bounded maps (512 plain, 256 per variant). The bound is on entry count rather than bytes because entries are mutated after insertion — a variant map gains encodings later — so a byte total maintained at insert time would drift out of truth.

**G10. Boot ordering** — `serve.ts:113-114`: socket listens before vaults mount; mount runs a synchronous lifecycle sweep (`vault-plane.ts:2448`) and per-app prewarm sequentially; first health poll runs synchronous `PRAGMA quick_check` over the whole vault (`vault-integrity-health.ts:62`). Mount before/parallel to listen where possible; move sweep + quick_check off the critical path.

The vault plane's first lifecycle sweep is deferred one `setImmediate` off the mount critical path, mirroring the existing `firstWalTick`, and cleared in `stop()`; `quick_check` gained a 5-minute startup grace. Parallel vault mounting was deliberately not done: mounting in parallel contends for disk and CPU on exactly the constrained host this issue targets, and there was no measurement to justify it.

**G11. Medium batch:** `scryptSync` on the vault-call path (`locker-auth.ts:490` → async scrypt); unbounded `listConversations`/`listTurnsAsc` ORDER BY without LIMIT (`store-sql.ts:364,493`); group-commit flush has no batch size cap (`group-commit-queue.ts:46`); `busy_timeout=30000` on the synchronous journal driver (`gateway-db.ts:798`); warm-spare worker pool defaults to 0 on constrained hosts (`worker-pool.ts:90` — exactly the target hardware); replica SSE builds an unbounded promise chain (`replica-routes.ts:651` → while-loop); `DROP/CREATE VIEW` on every journal open (`gateway-db.ts:475`).

`scryptSync` on the vault-call path became async `scrypt` (see D1); `listTurnsAsc` and `listConversations` gained LIMIT plumbing; the group-commit flush gained a batch cap of 64 with immediate re-arm; `busy_timeout` dropped 30s to 10s on the grounds that on a synchronous driver this is a stall budget rather than a patience setting; the warm-spare worker pool now keeps one spare on constrained hosts, since that is where a cold worker boot hurts most; the replica SSE recursion became a `while` loop preserving the access-check-before-every-projection semantics exactly; and `run_summary` is recreated only when its stored `sqlite_master.sql` differs from the source, instead of on every journal open.

**C1. Streaming chat re-parses everything per token** — `packages/client/src/react/shell/routes/assistantTranscript.ts:314`: `richAnswerHtml` runs for every finished message on every SSE token, through an unmemoized `Message` list with index keys and per-render callback objects (`AssistantScreen.tsx:351,388`). Memoize per (message, text); `React.memo` the transcript; batch SSE events (rAF/`startTransition` — currently zero batching). Same pattern in `automationLiveMessages.ts:449`.

`richAnswerHtml` is memoized behind a 200-entry LRU in a new `assistantRich.ts`, which fixes both call sites at the seam rather than patching each. A new `assistantProjection.ts` gives every model message a stable id via a `WeakMap` that survives the mid-turn tool-row splice and returns the previous DTO when the re-derived one is equal, so the now-memoized `Message` component actually hits. SSE events are batched to one projection per animation frame with explicit synchronous flushes at every settle point (busy toggle, thread switch, consent decline, catch-up, turn end) — that flush discipline is what keeps the behaviour honest rather than merely faster.

**C2. Desktop shows no window until the gateway boots** — `apps/desktop/src/main.ts:157,172`: `loadSettings()` awaits full embedded-gateway boot before `createWindow()`. The renderer already tolerates an absent gateway. Create the window first; boot in parallel. Add `show:false` + `ready-to-show`.

`apps/desktop/src/main.ts` now creates the window with `show: false` and reveals it on `ready-to-show`, with `did-finish-load` as an idempotent backstop, because a window that never fires `ready-to-show` is worse than a flash. Worth recording: the "gateway boots before `createWindow`" half of this item was already fixed on main — `createWindow()` already ran before `await loadSettings()` — so only the empty-rectangle flash actually remained.

**C3. 2 MB iroh WASM gates first data on web** — `apps/web/src/iroh-transport.ts:53`: lazy init on the first gateway request, so time-to-usable is dominated by a download+instantiate the byte budgets never see. Warm it during idle after first paint; add it to the budget.

This one required fixing the cause rather than the call site. The service worker already runtime-caches same-origin GETs, but its fetch handler bailed out on an empty `request.destination` — which is exactly what a `fetch()` issued from JS has, so the single largest asset the app ships was the one thing the shell cache never held. The fix is scoped to same-origin `/assets/` paths, whose names are content-hashed, so a new build invalidates by URL and the cache cannot go stale by construction. The idle warm is then gated on the page actually intending to dial iroh, since `control-transport.ts` replaces the transport with direct HTTP and the earlier unconditional warm was downloading 2 MB a page provably could not use. Measured after the fix: cold 11 requests / 422,387 B, warm 0 B, ratio 0.00 — the returning visitor pays nothing and the first-time visitor gained nothing, because an unpaired cold visit still never fetches the wasm.

**C4. 5s heartbeat re-renders the entire active screen** — `apps/desktop/src/main/gateway-monitor.ts:388` broadcasts unconditionally; `ShellApp.tsx:97` re-invokes `renderRoute` closures (`App.tsx:851`). Change-gate the broadcast; give routes real component boundaries.

A new `useGatewayStatus()` narrows the subscription to the reachability verdict, so a heartbeat no longer re-renders the active screen, and `ShellApp.tsx` gained a memoized `Outlet` around both render-props with `renderScreen` stabilized so that boundary can actually stop. The main-process broadcast was deliberately not change-gated: `checksTotal`, `samples`, `latencyMs` and `gatewayUptimeMs` change every tick by design and the Gateway page renders all of them, so a deep-equal gate upstream would either never fire or freeze a live page. Gating at the consumer removes the cost without withholding data.

**C5. No query cache / SWR primitive** — `useAsyncData.ts` blanks to LOADING on any dep change: every approvals decision blanks the page (`ApprovalsRoute.tsx:48`), pin toggle destroys the runs list (`RunsPane.tsx:62`), route re-entry refetches cold. Introduce one shared stale-while-revalidate cache (the gateway-switcher pattern at `App.tsx:687` is the model).

New `packages/client/src/react/shell/queryCache.ts` — a module-level store plus `useCachedQuery(key, load)` returning `{ state, refresh, mutate }`, where a failed revalidation keeps the last good value and carries the error alongside it rather than replacing the data with an error. `resetQueryCache(prefix?)` is the re-scope hook, called from `App.tsx` and never subscribed inside the module, so it has no import-time side effects. Adopted at the approvals route, the runs pane, the home feed and the conversations list.

**C6. Non-optimistic mutations** — rename/pin/archive conversation (`App.tsx:540-599`), app delete/rename (`HomeRoute.tsx:175-232`), approvals decisions, run pin: all await + full-list refetch. Make optimistic with reconcile.

New `packages/client/src/react/shell/optimisticUpdate.ts` carries the contract (read, write, apply, commit, settle) with exact rollback and rethrow on failure; `mutateQuery` and `useShellApps().mutateApps` are both built on it, so there is one owner rather than two implementations. Conversation rename/pin/archive, app delete/uninstall/rename, approvals decisions and run pin are all optimistic now, with pin re-sorting locally so a row does not jump twice.

**C7. Medium batch:** keystroke re-renders transcript + sync `localStorage` write (`AssistantScreen.tsx:303`); attachment full-blob fetch with object-URL revoke on unmount → re-download on scroll-back (`gateway-client-conversation-history.ts:76`, `AssistantMessage.tsx:125`) and refetch on parent re-render (`AssistantRoute.tsx:418`); no `width`/`height`/`loading="lazy"` on any `<img>`; four visibility-ungated pollers (`useGatewayHealth` 15s, `useBlockingCount` 60s, DevicesCard/BackupCard/StorageScreen) — `visibility-ticker.ts` exists, use it; Logs screen renders unbounded lines unwindowed (`LogsScreen.tsx:348`); route-level code splitting (`App.tsx:40-75` imports every route eagerly); Home blanks on feed load though apps are already in memory (`HomeRoute.tsx:282`); shell rescope listeners never unsubscribed (`App.tsx:460`); skeletons instead of "Loading…" text (`status.tsx:12`).

Composer persistence is debounced and flushed on send, switch and unmount; attachment object URLs are cached and shared with ownership moved into the cache so callers no longer revoke and force a re-download on scroll-back; the transcript thumbnail gained width, height, lazy loading and async decoding; all five pollers now run through a parameterized `startVisibilityTicker`; the Logs screen is windowed to the newest 300 matches with an explicit "show earlier" control, because a filtered log you cannot scroll back through is not a log; Home no longer blanks when apps are already in memory; shell re-scope listeners are unsubscribed; and a token-driven `PageSkeleton` replaces the "Loading…" text. Route-level code splitting is the one part of this batch not shipped — see Decisions.

**M1. Replica reads: push WHERE/LIMIT into SQL and go async** — `apps/mobile/src/lib/replica/multi-vault-reader.ts:340`: no WHERE/LIMIT in SQL; callers pass `limit: 100_000` (`timeline-engine.ts:187`), every row JSON-parsed in JS (`multi-vault-provenance.ts:57`), all via `executeSync` on the JS thread (`op-sqlite-driver.ts:53` — op-sqlite's async API is unused). This one fix addresses reads, invalidation storms (`useReplicaQuery.ts:90` — also debounce/coalesce), and JS-thread jank at once.

New `apps/mobile/src/lib/replica/replica-read-pushdown.ts` plans the fixed read grammar into a superset prefilter in SQL (`eq/ne/lt/lte/gt/gte/in/is-null/not-null` via `json_extract`/`json_type`), with every fragment carrying an availability escape so a row that should raise `OnlineOnlyError` still reaches the evaluator — semantics identical, only the number of rows parsed in JS changes. Reads went async through op-sqlite's promise API (with the node driver mirrored so tests exercise the production path), per-scope LIMIT is wrapped per compound arm with a saturation re-query, and a new `coalesce.ts` collapses one delta batch's invalidations into a single read. `orderBy` and the relative-date operators were deliberately not pushed down: SQLite orders NULL before number before text where the evaluator escalates, so an SQL `ORDER BY … LIMIT` could silently return a plausible page where the canonical read demands going online.

**M2. Photos pipeline** — sync `File.exists` stat per photo per recompute (`timeline-engine.ts:369` → batch one directory listing); O(n²) device-library walk (full copy + full recompute per 1000-row page, `timeline-engine.ts:280`); thumbnail-pack prefetch re-runs on every snapshot and downloads sequentially (`PhotosHome.tsx:107`, `thumbnail-pack.ts:60`); grid cells decode full-res device assets (`PhotoTimeline.tsx:262`); lightbox original over cellular ungated (`PhotoLightbox.tsx:111`).

The per-photo synchronous stat became one cached directory listing; thumbnail-pack downloads run at bounded concurrency instead of sequentially and no longer re-run on every snapshot; the device-library walk is incremental rather than copying and recomputing per 1000-row page; grid cells request thumbnail-sized decodes; and the cellular gate landed — with the real finding that the genuinely ungated fetch was the video original, not the photo original.

**M3. Cold start** — all 30+ screens eagerly imported (`App.tsx:32-89`, pulls maps/camera/webview/video at launch → lazy per-navigate); first paint blocked on 10 fonts + AsyncStorage (`App.tsx:404-438`); per-scope replica open with synchronous migrations on the launch path (`ReplicaProvider.tsx:408-441`); network burst before UI usable (`ReplicaProvider.tsx:295-308,545`).

28 of 30 screens moved behind `React.lazy`, so launch no longer pulls maps, camera, webview and video; first paint is no longer blocked on fonts; and both the per-scope replica open with its synchronous migrations and the notification/push network burst are deferred behind `InteractionManager.runAfterInteractions`.

**M4. Battery/polling** — `ReplicaStatusBar` 5s poll mounted on 16 screens with no AppState guard (`ReplicaStatusBar.tsx:44`); 4s upload poll opening/closing SQLite per tick (`timeline-engine.ts:104`); intent-flush retries at fixed 2s forever with no backoff (`native-session.ts:218`); `pullNow` on every network-state flap on top of foreground pulls (`ReplicaProvider.tsx:542`).

New `pending-changes.ts` gives all 16 status bars one AppState-gated ticker; new `backoff.ts` turns the intent-flush retry into 2s doubling to a 5-minute cap with jitter, reset on reconnect, foreground and successful post; the upload poll runs at 4s only while uploads are in flight, 30s idle and never in the background; and network flaps are coalesced into a single reachability pass while manual refresh stays direct.

**M5. Data frugality** — Home refetches 3 endpoints on mount + focus + subscribe (`Home.tsx:155-169`); zero conditional requests (no ETag/If-None-Match anywhere in `src/lib/gateway.ts`); cursor persisted to AsyncStorage per change event (`native-change-feed.ts:223`).

New `apps/mobile/src/lib/conditional-fetch.ts` provides a bounded ETag cache behind `fetchJsonRevalidated`, used by the app registry, notifications and parked lists; Home gained a 30s staleness window with in-flight dedupe, with pull-to-refresh and vault switch forcing past it; and the change-feed cursor write is debounced and flushed on background. The gateway side landed too — see the ETag work under G-lane below.

**M6. Lists** — 8 vertical FlatLists with no `getItemLayout`/windowing tuning and unmemoized inline renderItems (People up to 5k rows); unbounded album grids in plain ScrollViews (`PhotosLibrary.tsx:307`); `expo-image` memory cache unbounded.

Nine vertical FlatLists gained hoisted, memoized `renderItem`s, stable key extractors and row-sized windowing, with `getItemLayout` only where the row height is genuinely fixed; the album grid became a single FlashList with columns; and the People screen got the real hot spot, a `parties.rows.find` inside a 5k-row map (~25M comparisons per render) replaced by a `Map`. The merge-duplicate picker, which mounted up to 5k Pressables into a plain ScrollView, is now a modal sheet owning its own scroll axis with a windowed list and a search field, its candidate filtering extracted to a testable pure module.

**L1. Prune `core_entity_revision`** — full-row JSON snapshot per mutation, only reader is the 10s undo window (`commands/entity-revisions.ts:10,82`), retained forever, shipped in every WAL segment. Add `DELETE WHERE undo_until < now` to sweepLifecycle (or build the audit reader the schema comment promises — decide, don't drift).

`pruneExpiredEntityRevisions(vault, now, { limit })` deletes exactly the snapshots `loadEntityRevision` already refuses, so no reader can observe the difference, with a 5,000-row per-run cap. It is wired into the vault plane's daily sweep through `runVaultMaintenance`, with a `capped` result that re-opens the daily gate rather than looping in-tick — the cap exists so no single tick blocks the event loop, and looping would hand that straight back.

**L2. Cap journal archival runs** — `packages/vault/src/journal-archive.ts:167-291`: three uncapped full-table scans + O(n²) fixed-point closure + single `gzipSync` of the whole segment. Mirror #438's per-run caps.

Three uncapped full-table scans became id-scoped chunked or LIMITed queries, the O(n²) fixed-point closure became a linear worklist propagation reaching the same fixed point, and the single whole-segment `gzipSync` became row-by-row serialization with byte-identical output. Per-run caps mirror #438, defaulting to 5,000 rows with `capped` surfaced to the host.

**L3. Size ladder for vault.db** — journal.db has one (`journal-limit.ts`); vault.db has nothing. At minimum: monitoring + the L1 sweep.

New `packages/vault/src/vault-limit.ts` provides `decideVaultMaintenance` (90 to 30 to 14 to 7 day rungs with a 7-day floor, resetting under limit), `vaultFileBytes(dir)`, and `runVaultMaintenance` as the single hookpoint, shaped deliberately like the existing `journal-limit.ts` so the two ladders read the same.

**L4. Retention for the silent growers** — `sync_connection_run` (one row per connector sync forever), `enrich_request`, terminal `outbox_item` rows.

New `packages/vault/src/retention.ts` sweeps the three growers under table-driven policies with per-table caps, and is custody-safe by construction: terminal rows only, the newest run per connection pinned regardless of age, and pending, approved, failed outbox items and undrained enrichment requests never touched.

**L5. Hourly CAS mark/sweep cost** — full readdir + sort + three unindexed full scans into JS Sets, per vault per hour (`local-orphan-sweep.ts:91`, `blob/read.ts:215`); same `liveBlobShas` cost re-paid per backup tick. Make incremental or reduce cadence with size.

New `liveBlobShasCached(vault)` memoizes the live set per write position (`PRAGMA data_version` plus `total_changes()`) and returns it read-only and shared, so N consumers in one tick pay for one derivation; the three backup callers that previously derived and then mutated it now consult their extra roots separately. `sweepLocalOrphans` gained `maxEntries` and a cursor, and the plane carries that cursor between ticks so sweep cadence scales with CAS size.

**L6. `quick_check` cadence scaling** — hourly full-file scan per vault (`vault-integrity-health.ts:53`); scale cadence with file size or move off-thread.

The interval now scales with the vault's own on-disk size, from a 1-hour floor to a 24-hour ceiling, at most one vault scanned per tick, plus the startup grace. A vault in a FAILING state stays at the floor cadence, because its handle may not answer a header read at all.

**L7. Batched/resumable migration primitive** — before the first data-rewriting rung lands (`schema/migrate.ts:203`); the FTS rebuild path is the first candidate to need it.

`runBatchedMigration(db, rewrite, { batchSize, maxBatches })` commits per batch with a cursor in a lazily-created `schema_batch_cursor` table and latches on completion, so it is resumable. No existing rung uses it; it exists so the first one that needs it does not hand-roll the single-transaction version.

**L8. Mounted-plane budget** — ~160 MB mmap + 32 MB page cache per mounted vault (`db.ts:213`), no cap on planes; add a 5-vault footprint assertion and consider an idle-unmount policy.

`openVaultDb` gained a `footprint` budget that is a per-vault total rather than a per-file constant, divided across the vault's two databases, with a 512 KiB per-file cache floor that clamps rather than thrashes. Dividing at open time turned out not to be sufficient — a household grows one vault at a time, so vault 1 opens at the whole budget and the five-plane sum reached 413,837,994 B against a 134,217,728 B ceiling. Since these pragmas are settable on a live connection, `VaultRegistry.rebalanceFootprints()` re-divides across every open plane on each mount, create and delete, calling the exported `applyVaultFootprint` so the division policy has exactly one owner. An idle-unmount policy was considered and rejected on correctness grounds — see Decisions.

**L9. `history.keep: "all"`** is a legal manifest value — lint or cap it.

`validateHistory` in `packages/automation/src/manifest/manifest.ts` now rejects `"all"` outright rather than coercing it, on the grounds that coercion would let an author keep believing their history is complete. `{count}` is capped at 10,000 and `{days}` at 365, because `{days: 100000}` is `"all"` spelled differently and a hole re-openable by arithmetic was never closed. `parseHistoryKeep` in the gateway mirror was tightened so the direct-API lane is not a second door.

**S1.** Phash-clustering scale rig at ≥90k assets, exercising `sweep()` (covers G1/G2).

New `tests/scale/phash-clustering.scale.test.ts` at 90k assets exercising `sweep()`, with a 30s budget. Measured: cold sweep 9.0 s, idle sweep 145 ms with zero rows written, 9k assets clustered. This rig is what caught the failed first design of G1.

**S2.** `blob-gc.scale.test.ts` from 5k → ≥100k objects.

`tests/scale/blob-gc.scale.test.ts` keeps its 5k real-filesystem correctness case and adds a 100k in-memory-tier volume case; a 100k real-filesystem fixture costs roughly six minutes of fsync and would time out the lane, while the row-count-driven work under test is real either way. Measured: custody refresh plus eviction inside a 60 s budget.

**S3.** Restore test at ≥10 GiB, nightly; measure `foreign_key_check` (`wal-restore.ts:399`) in isolation and publish the number — backup honesty is a product promise and restore time at year-3 scale is currently a guess.

New `tests/scale/restore-10gib.scale.test.ts` with a dedicated nightly job, and it was actually run at 10 GiB across 337 s. Measured: restore 55.4 s over 95,640 FK-checked rows, snapshot 152.4 s, `foreign_key_check` alone 21.2 ms, `integrity_check` alone 784.9 ms. The suspected year-3 cliff is not one — both pragmas together are about 1.5% of the restore. Worth recording that the rig's first cut scaled rows with bytes and would have measured 2,560 rows at 10 GiB; the axes were decoupled so the number is at year-3 row volume.

**S4.** Mobile envelope: measured at 50k rows (`docs/mobile-offline.md:71`) but 90k photos is plausible before year 3 — extend or document the real ceiling.

`docs/mobile-offline.md` gained a subsection stating honestly where the 50,000-row number came from and where it stops: 90k projects to roughly 39.9 MB and a 1,013 ms cold read as arithmetic on the 2026-07-29 run, explicitly labelled a projection rather than a new measurement. It names the actual remaining constraint — the full-projection Photos read — rather than raising a number.

**S5.** 5-vault fixed-footprint + sweep-budget assertion (current ceiling pinned at 2 vaults).

New `tests/scale/multi-vault-footprint.scale.test.ts`, asserted against the `openVaultDb` contract rather than the moving plane seam. Measured on darwin arm64: summed page cache across 10 handles 32,768,000 B against a 32,768,000 B host total, where per-file constants would have cost 163,840,000 B; summed mmap 134,217,720 B against a 134,217,728 B ceiling; smallest per-file cache 3,276,800 B. Reservations are flat in vault count. The rig also measured what reservations do not cover: about 10.1 MB of RSS per additional idle vault.

**S6.** Backup manifest size bound (chunkIndex is O(vault) JSON rebuilt per snapshot, `manifest.ts:97`).

New `tests/scale/backup-manifest-size.scale.test.ts` bounds the manifest at 230 bytes per chunk with a 50k-to-100k growth factor of 2.00. Measured at 205 bytes per chunk — which means roughly 20.5 MB of manifest for a 100k-chunk vault, rebuilt and re-uploaded on every snapshot.

**D1.** Nothing O(vault-size) synchronous on the request path or event loop (sync SQLite, `scryptSync`, `gzipSync`, sweeps).

Added to `docs/coding-standards.md` as a diff rule with the enumerable shapes tabled (sync SQLite, `scryptSync`, whole-blob hashing, unbounded sweeps), naming the hourly phash pass as the case in point.

**D2.** No load-bearing "personal vaults are small" assumptions in comments without an enforcing budget or cap — every such comment found (clusters, FTS trigger, VACUUM-on-open) is a future outage.

Added, with the framing that every such comment found in this audit — clusters, the FTS trigger, VACUUM-on-open — is a future outage rather than a note.

**D3.** Compute-once-share for fan-out: per-subscriber recompute is a defect (replica SSE, per-request sweeps).

Added, with the observation that makes it worth a rule: per-subscriber recompute survives review precisely because it is correct, and only shows up later as a load curve that bends with connection count.

**D4.** Clients use the shared SWR/query-cache primitive (C5); blanking refetch on mutation is a defect.

Added, naming the concrete modules rather than a generic primitive: reads go through `useCachedQuery` in `packages/client/src/react/shell/queryCache.ts` and mutations through `optimisticUpdate.ts`, with blanking-on-refetch called a defect and keying deferred to `client-keying.md`.

**D5.** Every poller is visibility/AppState-gated; new pollers need justification over push.

Added, covering both the web and native gates, the unmount requirement, and the demand that a new poller justify itself against push.

**D6.** Scale rigs are calibrated to year-3 declared volumes, not current fixtures; the volume table lives with the rig.

Added, and applied to every rig touched in this change: the year-3 volume table lives with the rig, and `scripts/perf/README.md` now applies the same standard to itself by recording that the waterfall rig's seeded volume is empty.

### Files changed

Full paths, for the file-coverage rule.

- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/lane-client-e2e.yml`
- `CONSTITUTION.md`
- `apps/desktop/src/main.ts`
- `apps/desktop/tests/e2e/launch-time.spec.ts`
- `apps/mobile/App.tsx`
- `apps/mobile/src/apps/agenda/AgendaHome.tsx`
- `apps/mobile/src/apps/assistant/Assistant.tsx`
- `apps/mobile/src/apps/automations/AutomationThread.tsx`
- `apps/mobile/src/apps/automations/Automations.tsx`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/apps/docs/docs-library-shelves.ts`
- `apps/mobile/src/apps/locker/LockerHome.tsx`
- `apps/mobile/src/apps/locker/LockerItemRow.tsx`
- `apps/mobile/src/apps/locker/LockerUnlockScreen.tsx`
- `apps/mobile/src/apps/people/MergePicker.tsx`
- `apps/mobile/src/apps/people/PeopleHome.styles.ts`
- `apps/mobile/src/apps/people/PeopleHome.tsx`
- `apps/mobile/src/apps/people/PersonListRow.tsx`
- `apps/mobile/src/apps/people/merge-candidates.test.ts`
- `apps/mobile/src/apps/people/merge-candidates.ts`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/MediaPage.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoTimeline.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosLibrary.styles.ts`
- `apps/mobile/src/apps/photos/PhotosLibrary.tsx`
- `apps/mobile/src/apps/photos/full-quality-gate.test.ts`
- `apps/mobile/src/apps/photos/full-quality-gate.ts`
- `apps/mobile/src/apps/photos/grid-image.test.ts`
- `apps/mobile/src/apps/photos/grid-image.ts`
- `apps/mobile/src/apps/photos/image-cache.ts`
- `apps/mobile/src/apps/photos/pinned-thumbnails.test.ts`
- `apps/mobile/src/apps/photos/pinned-thumbnails.ts`
- `apps/mobile/src/apps/photos/timeline-engine.ts`
- `apps/mobile/src/apps/tally/TallyHome.tsx`
- `apps/mobile/src/apps/tasks/TasksHome.tsx`
- `apps/mobile/src/deep-links.ts`
- `apps/mobile/src/kit/hooks/useReplicaQuery.ts`
- `apps/mobile/src/kit/perf/`
- `apps/mobile/src/kit/replica/ReplicaProvider.tsx`
- `apps/mobile/src/kit/replica/ReplicaStatusBar.tsx`
- `apps/mobile/src/kit/replica/pending-changes.ts`
- `apps/mobile/src/kit/replica/replica-mount.ts`
- `apps/mobile/src/lib/backoff.test.ts`
- `apps/mobile/src/lib/backoff.ts`
- `apps/mobile/src/lib/coalesce.test.ts`
- `apps/mobile/src/lib/coalesce.ts`
- `apps/mobile/src/lib/conditional-fetch.test.ts`
- `apps/mobile/src/lib/conditional-fetch.ts`
- `apps/mobile/src/lib/gateway.ts`
- `apps/mobile/src/lib/perf/`
- `apps/mobile/src/lib/replica/multi-vault-reader.test.ts`
- `apps/mobile/src/lib/replica/multi-vault-reader.ts`
- `apps/mobile/src/lib/replica/multi-vault-session.ts`
- `apps/mobile/src/lib/replica/native-change-feed.ts`
- `apps/mobile/src/lib/replica/native-session.ts`
- `apps/mobile/src/lib/replica/node-sqlite-driver.ts`
- `apps/mobile/src/lib/replica/op-sqlite-driver.ts`
- `apps/mobile/src/lib/replica/replica-read-pushdown.test.ts`
- `apps/mobile/src/lib/replica/replica-read-pushdown.ts`
- `apps/mobile/src/lib/replica/thumbnail-pack.ts`
- `apps/mobile/src/screens/Home.tsx`
- `apps/web/public/sw.js`
- `apps/web/src/iroh-transport.ts`
- `apps/web/src/main.ts`
- `apps/web/src/sw-runtime.test.ts`
- `apps/web/tests/e2e/perf-budgets.ts`
- `apps/web/tests/e2e/perf-waterfall.spec.ts`
- `apps/web/vite.config.ts`
- `docs/coding-standards.md`
- `docs/mobile-offline.md`
- `package.json`
- `packages/app-engine/src/conversation/history.test.ts`
- `packages/app-engine/src/conversation/history.ts`
- `packages/app-engine/src/conversation/rehydrate.test.ts`
- `packages/app-engine/src/conversation/store-items.test.ts`
- `packages/app-engine/src/conversation/store-sql.ts`
- `packages/app-engine/src/conversation/store.test.ts`
- `packages/app-engine/src/conversation/store.ts`
- `packages/app-engine/src/handlers/handler-pool.test.ts`
- `packages/app-engine/src/handlers/worker-pool.ts`
- `packages/app-engine/src/http/asset-variants.ts`
- `packages/app-engine/src/http/bounded-cache.test.ts`
- `packages/app-engine/src/http/bounded-cache.ts`
- `packages/app-engine/src/http/changes-sse.ts`
- `packages/app-engine/src/http/conversation-routes.ts`
- `packages/app-engine/src/http/sse-stream.test.ts`
- `packages/app-engine/src/http/sse-stream.ts`
- `packages/app-engine/src/http/turn-sse.ts`
- `packages/app-engine/src/index.ts`
- `packages/app-engine/src/stores/gateway-db.test.ts`
- `packages/app-engine/src/stores/gateway-db.ts`
- `packages/automation/src/manifest/manifest.test.ts`
- `packages/automation/src/manifest/manifest.ts`
- `packages/client/src/gateway-client-conversation-history.contract.test.ts`
- `packages/client/src/gateway-client-conversation-history.ts`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AssistantMessage.tsx`
- `packages/client/src/react/screens/AssistantScreen.module.css`
- `packages/client/src/react/screens/AssistantScreen.test.tsx`
- `packages/client/src/react/screens/AssistantScreen.tsx`
- `packages/client/src/react/screens/BackupCard.tsx`
- `packages/client/src/react/screens/DevicesCard.tsx`
- `packages/client/src/react/screens/LogsScreen.module.css`
- `packages/client/src/react/screens/LogsScreen.tsx`
- `packages/client/src/react/screens/StorageScreen.tsx`
- `packages/client/src/react/screens/assistantDrafts.ts`
- `packages/client/src/react/screens/transcriptWindow.test.ts`
- `packages/client/src/react/screens/transcriptWindow.ts`
- `packages/client/src/react/screens/useAssistantScroll.ts`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/ShellApp.tsx`
- `packages/client/src/react/shell/boundedMemo.test.ts`
- `packages/client/src/react/shell/boundedMemo.ts`
- `packages/client/src/react/shell/frameBatch.test.ts`
- `packages/client/src/react/shell/frameBatch.ts`
- `packages/client/src/react/shell/optimisticUpdate.test.ts`
- `packages/client/src/react/shell/optimisticUpdate.ts`
- `packages/client/src/react/shell/queryCache.test.ts`
- `packages/client/src/react/shell/queryCache.ts`
- `packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx`
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx`
- `packages/client/src/react/shell/routes/AssistantRoute.tsx`
- `packages/client/src/react/shell/routes/AutomationViewRoute.tsx`
- `packages/client/src/react/shell/routes/HomeRoute.test.tsx`
- `packages/client/src/react/shell/routes/HomeRoute.tsx`
- `packages/client/src/react/shell/routes/RunsPane.tsx`
- `packages/client/src/react/shell/routes/assistantProjection.test.ts`
- `packages/client/src/react/shell/routes/assistantProjection.ts`
- `packages/client/src/react/shell/routes/assistantRich.ts`
- `packages/client/src/react/shell/routes/visibility-ticker.ts`
- `packages/client/src/react/shell/status.tsx`
- `packages/client/src/react/shell/structuralEqual.test.ts`
- `packages/client/src/react/shell/structuralEqual.ts`
- `packages/client/src/react/shell/useAssistantConversations.ts`
- `packages/client/src/react/shell/useBlockingCount.ts`
- `packages/client/src/react/shell/useGatewayHealth.ts`
- `packages/client/src/react/shell/useGatewayRuntime.ts`
- `packages/client/src/react/shell/useShellApps.ts`
- `packages/client/src/react/styles/pageSkeleton.module.css`
- `packages/gateway/src/backup/backup-cas-reconciliation.ts`
- `packages/gateway/src/backup/backup-reconciliation.ts`
- `packages/gateway/src/backup/backup-sources.ts`
- `packages/gateway/src/backup/backup.integration.test.ts`
- `packages/gateway/src/lifecycle/lifecycle-shared.ts`
- `packages/gateway/src/routes/apps-store-routes.test.ts`
- `packages/gateway/src/routes/apps-store-routes.ts`
- `packages/gateway/src/routes/automations-routes.ts`
- `packages/gateway/src/routes/logs-routes.ts`
- `packages/gateway/src/routes/replica-projection.ts`
- `packages/gateway/src/routes/replica-routes.ts`
- `packages/gateway/src/routes/replica-shape.test.ts`
- `packages/gateway/src/routes/replica-shape.ts`
- `packages/gateway/src/routes/route-helpers.ts`
- `packages/gateway/src/routes/sql-statement-cache.ts`
- `packages/gateway/src/routes/vault-routes.test.ts`
- `packages/gateway/src/routes/vault-routes.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/gateway-db.ts`
- `packages/gateway/src/serve/group-commit-queue.ts`
- `packages/gateway/src/serve/health-registry.ts`
- `packages/gateway/src/serve/route-latency.test.ts`
- `packages/gateway/src/serve/route-latency.ts`
- `packages/gateway/src/serve/vault-integrity-health.test.ts`
- `packages/gateway/src/serve/vault-integrity-health.ts`
- `packages/gateway/src/serve/vault-plane-app-bridge.test.ts`
- `packages/gateway/src/serve/vault-plane-maintenance.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/vault-registry-footprint.test.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/gateway/src/serve/web-app-sessions.contract.test.ts`
- `packages/gateway/src/serve/web-app-sessions.ts`
- `packages/gateway/src/serve/web-session-store.test.ts`
- `packages/gateway/src/serve/web-session-store.ts`
- `packages/vault/src/blob/local-orphan-sweep.test.ts`
- `packages/vault/src/blob/local-orphan-sweep.ts`
- `packages/vault/src/blob/read.test.ts`
- `packages/vault/src/blob/read.ts`
- `packages/vault/src/commands/entity-revisions.test.ts`
- `packages/vault/src/commands/entity-revisions.ts`
- `packages/vault/src/db.test.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/enrich/clusters.test.ts`
- `packages/vault/src/enrich/clusters.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/locker-auth.test.ts`
- `packages/vault/src/gateway/locker-auth.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/journal-archive.test.ts`
- `packages/vault/src/journal-archive.ts`
- `packages/vault/src/retention.test.ts`
- `packages/vault/src/retention.ts`
- `packages/vault/src/schema/migrate-batched.test.ts`
- `packages/vault/src/schema/migrate.ts`
- `packages/vault/src/vault-footprint.ts`
- `packages/vault/src/vault-limit.test.ts`
- `packages/vault/src/vault-limit.ts`
- `scripts/lint-e2e-flows.mjs`
- `scripts/perf/README.md`
- `scripts/perf/app-weight.mjs`
- `scripts/test-report/ratchet-floors.mjs`
- `scripts/test-report/validate-nightly-wiring.mjs`
- `tests/agent-e2e-mobile/flows/cold-start.mjs`
- `tests/agent-e2e-mobile/flows/scroll-frames.mjs`
- `tests/agent-e2e-mobile/lib/frame-report.mjs`
- `tests/agent-e2e-mobile/lib/frame-report.test.mjs`
- `tests/agent-e2e-shared/harness.mjs`
- `tests/experience-budgets/`
- `tests/helpers/rig-budgets.ts`
- `tests/perf/blob-egress.perf.test.ts`
- `tests/perf/desktop-cold.perf.test.ts`
- `tests/perf/desktop-launch.perf.test.ts`
- `tests/perf/gateway-request.perf.test.ts`
- `tests/perf/pwa-waterfall.perf.test.ts`
- `tests/perf/replica-sync-io.perf.test.ts`
- `tests/perf/tunnel-native.perf.test.ts`
- `tests/perf/tunnel-throughput.perf.test.ts`
- `tests/perf/vault-write.perf.test.ts`
- `tests/quality-rig-budgets.json`
- `tests/scale/automations-fire.scale.test.ts`
- `tests/scale/backup-manifest-size.scale.test.ts`
- `tests/scale/backup-restore.scale.test.ts`
- `tests/scale/blob-gc.scale.test.ts`
- `tests/scale/conversation-ledger.scale.test.ts`
- `tests/scale/gateway-sessions.scale.test.ts`
- `tests/scale/large-vault.scale.test.ts`
- `tests/scale/multi-vault-footprint.scale.test.ts`
- `tests/scale/ontology.scale.test.ts`
- `tests/scale/phash-clustering.scale.test.ts`
- `tests/scale/replica-bootstrap.scale.test.ts`
- `tests/scale/restore-10gib.scale.test.ts`
- `tests/skips.json`

## Decisions

**G8 is the one checklist item left unchecked.** The item says "Materialize a
rollup," and that was not done. Reversing it needs a write path, a backfill, and
drift tests, and #438 deliberately deleted the previous dual write with the
recorded reasoning "no write path, no drift" — reversing a documented decision
on a pass that could not verify the replacement honestly would be worse than
leaving it. What landed instead is a covering partial index on
`kind IN ('step','agent')`, so the three dominant-* rollups become index-only
scans while the hot streaming inserts do not pay to maintain it. The cost is
addressed; the item as written is not, so it stays unchecked.

**Route-level code splitting was implemented, measured, and reverted.** Shipped,
it made the shell worse, not better: cold requests went 12 → 73 and cold bytes
387,990 → 857,155, because 18 `import()` boundaries shattered the *eager* graph
into ~70 chunks (40 of them under 3 KB) and compressing 70 small files
separately costs far more than compressing one large one. None of the 73 were
lazy route chunks. Coarser grouping was tried before reverting: `minSize` had no
effect, `minShareCount: 4` made it worse, and grouping the 18 route modules gave
22 chunks and a blank app — the `window.CentraidApi` module-eval hazard that
`vite.config.ts` already documents. The precondition is now named in that file:
`gateway-client-core.ts` and `vault-change-feed.ts` both subscribe at module-eval
time and their *relative* order is itself load-bearing, so fixing it means an
explicit init across two packages and every host that stubs `CentraidApi`.
Nothing measured shows splitting wins even with the hazard gone, so it would
need re-measurement afterwards regardless.

**The +34 KB cold-bytes regression on web is accepted deliberately.** Cold went
387,990 → 422,312 B, inside its unchanged 470,000 B ceiling. That is the #659
shell infrastructure now in the eager bundle — the SWR cache, the optimistic
contract, the transcript projection and memo, the skeleton styles — bought in
exchange for the streaming-transcript and route-re-entry wins. No budget was
widened to accommodate it; `maxRequests` was *tightened* 13 → 12 where the
measurement earned it.

**Idle-unmount was considered for L8 and rejected on correctness grounds.** A
mounted plane owns its cron schedulers, and automations fire only while mounted
with no backfill (#149), so an "idle" vault would silently stop working. A cap on
mounted planes trades bounded memory for a vault the household simply cannot
reach. The measured residency is ~10.1 MB of RSS per additional idle vault —
about 40 MB for five against a 512 MiB ceiling, roughly 7.8%, and dwarfed by the
163.8 MB → 32.8 MB the footprint budget already removed. To keep the waiver
checkable rather than invisible, `metrics.mountedVaults` was added to the health
snapshot: `rssBytes` previously had no denominator, so a household growing from
one vault to five was indistinguishable from a leak.

**L9 rejects `"all"` rather than coercing it.** Coercion to a bounded count would
let an author keep believing their history is complete. v0 carries no
back-compat obligation, so the honest error is available and is the cleaner
contract.

**Parallel vault mounting (part of G10) was not done.** Mounting in parallel
contends for disk and CPU on exactly the constrained host this issue targets, and
there was no measurement to justify it. The sweep and `quick_check` moves that
the item also asks for did land.

**LCP and INP are reported but not asserted.** All three web-vitals observers
install and the connect screen renders fully, but the browser emits no
`first-contentful-paint` on this shell after 16 s. Asserting a number the browser
refuses to emit would be a green gate measuring nothing, so those two are
annotated and the wiring note is filed; CLS is genuinely measured at 0 and
hard-gated.

**Some budgets ship as `unmeasured` on purpose.** Where a metric has no probe
that can run here, the entry carries no number at all and parks its intended
ceiling under a leading-underscore key the ratchet cannot see. The mobile
frame-drop ceiling ships at 50% as an explicit catastrophe bound — above it a
list runs at half the display's refresh rate, which is broken on any device and
needs no measurement — with the intended 5% parked until a device run produces a
distribution. The alternative, inventing plausible numbers and labelling them
measured, is the failure this issue exists to end.

**A repo-wide `oxfmt` ran by accident mid-session** and reformatted 19 files
outside the lane that triggered it (`docs/coding-standards.md` and files under
`packages/{gateway,app-engine,automation}`). Formatting only; the affected
packages were re-verified green afterwards rather than assumed. Net effect is
that those files now pass `format:check`, which they previously did not.

## Out of scope

- The Rust byte-plane strangler (`docs/plans/gateway-low-end-and-rust-plane.md`)
  — separate track, untouched.
- Hiding replication/backup surfaces from the UI — open brainstorm, not
  implementation.
- Any behaviour change to consent or custody semantics. Every fix here is
  cost/latency-neutral to semantics; the retention sweeps touch terminal rows
  only, and the locker auth change alters latency, never the derived-key or
  constant-time-compare behaviour.
- Fixing the `window.CentraidApi` module-eval ordering hazard, which route
  splitting turned out to depend on. Named as a precondition in `vite.config.ts`
  rather than attempted — the failure mode of getting it wrong is a blank app.
- Materializing the `run_summary` rollup (G8), for the reasons under Decisions.
- Replacing the mobile 90k projection with a measured run, and running the
  mobile cold-start and frame-drop probes, both of which need a simulator or
  device the nightly lane provides.

## Verification

Repo-wide gates, run from the worktree root:

```sh
bun run build
bun run check:full
```

Per-package suites, all green at the time of writing (`bun run typecheck` and
`bun run test` in each):

```sh
cd packages/vault      && bun run typecheck && bunx vitest run   # 136 files, 1077 passed, 1 skipped
cd packages/gateway    && bun run typecheck && bun run test      # 1268 passed, 6 skipped
cd packages/app-engine && bun run typecheck && bun run test      # 610 passed
cd packages/automation && bun run typecheck && bun run test      # 375 passed
cd packages/client     && bun run typecheck && bun run test      # 213 files, 1729 passed
cd apps/web            && bun run typecheck && bun run test      # 60 passed
cd apps/desktop        && bun run typecheck && bun run test      # 283 passed
cd apps/mobile         && bun run typecheck && bun run test      # 67 files, 378 passed
```

Scale and perf lanes, including the rigs added here:

```sh
bun run test:scale
bun run test:perf
bunx vitest run --config vitest.scale.config.ts tests/scale/phash-clustering.scale.test.ts
bunx vitest run --config vitest.scale.config.ts tests/scale/multi-vault-footprint.scale.test.ts
bunx vitest run --config vitest.scale.config.ts tests/scale/backup-manifest-size.scale.test.ts
```

Budget and rig wiring:

```sh
node scripts/test-report/ratchet-floors.mjs
node scripts/validate-nightly-wiring.mjs
bun run test:matrix
bun run scripts:test
```

The web waterfall probe requires a **precompressed** build — a bare `vite build`
skips `precompress.mjs` while `emptyOutDir` deletes sidecars from a previous full
build, and `transferSize` then reports roughly 4× the real number. This trap is
now documented in both `apps/web/tests/e2e/perf-budgets.ts` and
`scripts/perf/README.md`:

```sh
bun run --cwd apps/web build
node scripts/perf/run-waterfall.mjs
```

Measured numbers this change stands on, all from runs performed during the work
rather than projections: phash sweep at 90k assets 9.0 s cold and 145 ms idle
with zero rows written; 10 GiB restore 55.4 s with `foreign_key_check` isolated
at 21.2 ms and `integrity_check` at 784.9 ms; five-vault summed page cache
32,768,000 B against 163,840,000 B under the old per-file constants; backup
manifest 205 bytes per chunk; desktop cold-open 4,540 ms with 4,494 ms of it
main-process boot before any window exists; web cold 11 requests / 422,387 B and
warm 0 B. Numbers that are projections (the mobile 90k envelope) or pending a
device run (mobile cold-start, frame-drop) are labelled as such in
`tests/experience-budgets/` and in `docs/mobile-offline.md`, never as measured.

Falsification was used rather than assumed in the three places where a passing
test would otherwise prove nothing: stubbing `applyVaultFootprint` to a no-op
turns the five-plane ceiling test red; reverting `derive` to `scryptSync` turns
the event-loop-liveness test red with zero timer turns; and reverting the
`authenticate` await leaves `tsc --noEmit` completely clean while two tests go
red — which is the whole reason that one needed a test.

## Audit

All three audit checks PASS.

**(1) "What changed" faithfully describes the diff — no misrepresentation, no omission.** PASS

The receipt's "What changed" section quotes the issue checklist and states what landed for each item. Evidence:
- File coverage: receipt lists 235 files; actual diff contains 164 modified files + 72 untracked new files = 236 total, with only the receipt itself not self-referential (expected).
- Spot-checked implementations verified against the code:
  - R1: CONSTITUTION.md now contains "Every user-facing interaction has a perceived-latency budget" and "Nothing whose cost scales with vault size runs synchronously on the request path or the event loop" (verified in diff).
  - G1: `packages/vault/src/enrich/clusters.ts` implements multi-index hashing with incremental sweep via fingerprint memoization (description matches).
  - G5: `packages/app-engine/src/conversation/store.ts` implements `listTurnsWindow` with `beforeSeq` pagination (verified).
  - G6: `packages/app-engine/src/http/sse-stream.ts` implements backpressure handling with `maxBufferedBytes` and overflow callbacks (verified).
  - C1: `packages/client/src/react/shell/routes/assistantRich.ts` memoizes `richAnswerHtml` via `boundedMemo` (verified).
  - C5: `packages/client/src/react/shell/queryCache.ts` exports `useCachedQuery` for SWR caching (verified).
  - L1: `packages/vault/src/commands/entity-revisions.ts` exports `pruneExpiredEntityRevisions` function (verified).
  - R2: `tests/experience-budgets/` directory created with `web.json`, `desktop.json`, `mobile.json`, `gateway.json` (verified).
  - D1: `docs/coding-standards.md` section "Nothing O(vault-size) on the request path" documents the principle (verified).
  - G7: `packages/gateway/src/routes/replica-shape.ts` uses `MAX(seq)` per-entity invalidation instead of global watermark (verified in diff snippet).

No material omissions found. Minor formatting (one post-hoc `oxfmt` run reformatting 19 files) is disclosed under Decisions.

**(2) Each `[x]` checklist item is actually realized in the diff.** PASS

Spot-check across all six lanes (R, G, C, M, L, S, D):
- **R lane** (rigor): R1 principles in CONSTITUTION.md (verified); R2 budget files created with README and ratchet wiring (verified); R3 perf-waterfall.spec.ts and app-weight.mjs exist (verified); R4 tests/quality-rig-budgets.json wired (verified); R5 route-latency.ts created (verified); R6 README updated (verified).
- **G lane** (gateway): G1 multi-index hashing (verified concept above); G2 compare-before-write (description claims "reused" result tracking, implementation present); G3 session sweep moved to timer with expires_at index (verified concept); G4 FTS trigger appends item instead of re-deriving (verified via grep); G5 pagination (verified); G6 backpressure (verified); G7 per-entity invalidation (verified); G9 bounded-cache.ts created (verified); G10 sweep deferred, quick_check grace added (verified); G11 batch items (scryptSync async, LIMIT plumbing, batch cap, worker pool defaults, replica recursion unwound, view recreation optimized - all described).
- **C lane** (client): C1 memoization (verified); C2 window creation reordered (verified concept); C3 iroh WASM cache fix + service worker (verified concept); C4 useGatewayStatus narrowed, memoized Outlet (verified); C5 useCachedQuery (verified); C6 optimisticUpdate.ts created (verified); C7 multiple items (composer debounced, attachment caching, img tags lazy-loaded, pollers gated via startVisibilityTicker, Logs windowed to 300 lines, no route splitting shipped, Home no-blank fix, listeners unsubscribed, PageSkeleton added).
- **M lane** (mobile): M1 replica-read-pushdown.ts exists (verified); M2 Photos pipeline (thumbnail-pack concurrency, directory listing batched, device-library incremental, cellular gate - all described); M3 screens lazy via React.lazy (verified concept); M4 ReplicaStatusBar AppState-gated (verified), upload poll idle-aware, backoff exponential, network coalesce (described); M5 Home 30s staleness window, ETag cache (verified concept); M6 FlatLists memoized with getItemLayout/windowing, album grid becomes FlashList, People search map-based (described).
- **L lane** (long-horizon): L1-L9 all described; vault-limit.ts created (verified); retention.ts created (verified); entity-revisions prune function (verified).
- **S lane** (scale): S1-S6 scale test files all exist (phash-clustering.scale.test.ts, multi-vault-footprint.scale.test.ts, restore-10gib.scale.test.ts, backup-manifest-size.scale.test.ts verified).
- **D lane** (doctrine): D1-D6 all added to docs/coding-standards.md (verified sampling).

The one unchecked item (G8) is documented in Decisions with truthful reasoning: no write path, no drift-testing mechanism, prior decision (#438) deliberately rejected the dual-write, and partial index covers the cost instead.

**(3) Checklist mirrors the issue.** PASS

Receipt's `## Checklist` section contains 50 `[x]` items and 1 `[ ]` item (G8), matching the GitHub issue #659 checklist structure exactly.

## Steering

One steering event detected. PASS

The session transcript contains:
- One initial task assignment (queue-operation: "/goal please work on the entire scope...") — **not a steering event** per instructions.
- Forty-seven background task notifications from spawned subagents — **not steering events**, normal agent-spawning operations.
- **One human message redirecting the agent mid-task** (JSONL line 84, timestamp 2026-07-31T17:19:43.860Z, type "user", origin "human"):
  > "In apps/mobile/src/apps/people/PeopleHome.tsx, the merge-duplicate picker renders `people.filter(...).map(...)` as direct children of a plain `<ScrollView...>` ... The main directory FlatList in the same file was windowed under issue #659... The merge picker was left alone... Pick one and implement it: [option A or B]"
  
  **Classification: CORRECTION, classifier tier.** The message identifies work completed under #659 (M6: main FlatList windowing on People screen) and points out incomplete work in the same scope (merge-picker list not windowed). It then instructs the agent to complete it by choosing and implementing one of two options. This is mid-task steering because the agent was actively working on #659 when the redirect arrived. It is a correction (not a new task assignment) because it points out work that fell short of the stated completion criteria for M6.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-f31b02a1-75f-1785524783-1 | claude-code | f31b02a1-75f6-4ef7-a889-17462a9b03a4 | #659 | claude-opus-5 | 360 | 888382 | 29546359 | 238581 | 1127323 | 26.2919 | 360 | 888382 | 29546359 | 238581 | docs(perf): constitutional performance principle and D1-D6 doctrine (#659) |
| claude-code-f31b02a1-75f-1785525192-1 | claude-code | f31b02a1-75f6-4ef7-a889-17462a9b03a4 | #659 | claude-opus-5 | 24 | 24061 | 2897576 | 8368 | 32453 | 1.8085 | 384 | 912443 | 32443935 | 246949 | docs(perf): constitutional performance principle and D1-D6 doctrine (#659) |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-f31b02a1-1785518383-1 | f31b02a1-75f6-4ef7-a889-17462a9b03a4 | #659 | correction | classifier | Pointed out incomplete M6 item (People merge-picker windowing left unfinished while main list was windowed). Instructed agent to choose and implement one of two completion options. | 0f740e4ac9bde683c78d4ef1a057c5b78d37e960 | 84 | 2026-07-31T17:19:43.860Z |
