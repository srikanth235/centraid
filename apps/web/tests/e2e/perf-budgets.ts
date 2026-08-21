// Single source of truth for the PWA fast-path performance budgets
// (issue #404 workstream I). Every ceiling here is derived from a MEASURED
// baseline captured by perf-waterfall.spec.ts against the e2e harness, then
// padded with headroom so normal CI jitter never trips a red build.
//
// HOW TO UPDATE (read before touching a number):
//   1. Run `node scripts/perf/run-waterfall.mjs` (or `bunx playwright test
//      perf-waterfall -c tests/e2e/playwright.config.ts` from apps/web after a
//      `vite build`). It writes test-results/perf-waterfall-report.json and
//      prints a SUMMARY table.
//   2. Set each ceiling from the measured value plus the documented headroom.
//   3. When the bundling / code-split workstream lands and the numbers DROP,
//      re-measure and TIGHTEN these — the whole point of the budgets is to
//      lock in the win and catch a future regression that re-inflates it.
//
// The app-open budgets are measured against a real bundled system app opening
// inline in the shell (#799 retired the tiny served fixture the earlier
// numbers were taken from). Their VALUE is the methodology + the regression
// fence: the ratios (warm-vs-cold, connect-vs-stream) hold regardless of which
// app is measured, and the absolute ceilings move with its chunk graph.
//
// Timing budgets hard-fail when `enforceTiming` is true (issue #468 L5).
// Request-count and byte budgets remain hard gates regardless.

export interface OpenBudget {
  /** Max resource-timing entries (`performance.getEntriesByType('resource')`). */
  maxRequests: number;
  /** Max summed `transferSize` in bytes for SAME-ORIGIN resources. */
  maxTransferBytes: number;
}

export interface AppOpenBudget extends OpenBudget {
  /**
   * Max summed `encodedBodySize` in bytes for SAME-ORIGIN resources.
   *
   * `transferSize` is 0 for anything the service worker answers out of Cache
   * Storage, and by the time an app can be opened the SW has precached the
   * whole dist — so wire bytes for an inline app open are 0 and cannot fence
   * WEIGHT. `encodedBodySize` is populated either way, so it is what grows
   * when an app's chunk grows. The two ceilings fence different regressions:
   * `maxTransferBytes` says "an open must not go back to the network",
   * `maxEncodedBytes` says "an open must not get heavier".
   *
   * READ IT AS DECODED (RAW) WEIGHT, NEVER AS A WIRE FIGURE. Cache Storage
   * holds decoded bodies, so an SW-served chunk reports its raw size here —
   * measured directly: a 50,020-byte script served from the SW cache reports
   * `transferSize: 0, encodedBodySize: 50,020`. Brotli would put the same
   * chunk near a quarter of that, so re-seeding this ceiling off a compressed
   * number would set it ~4x too tight.
   */
  maxEncodedBytes: number;
  /**
   * Min summed `encodedBodySize` in bytes for SAME-ORIGIN resources — an
   * up-only FLOOR, not a ceiling (`ratchet-floors.mjs` treats `min*` keys as
   * floors, so lowering one needs an approvedDeviation just as widening a
   * ceiling does).
   *
   * A bare `> 0` guard is not enough to keep this rig honest. If a future
   * shell change modulepreloads the app chunk, or the bundling workstream
   * folds `app-inline` into `boot` (the stated goal in scripts/perf/README.md),
   * the measured cold delta collapses from ~112 KB to whatever incidental byte
   * lands in the window — every ceiling above passes, and the app-open weight
   * ratchet silently stops measuring the app. The floor makes that failure
   * loud instead of green.
   */
  minEncodedBytes: number;
  /**
   * Max resource-timing entries across ALL origins, not just same-origin.
   *
   * The byte fences above are deliberately same-origin, because the harness
   * gateway answers on another port without a Timing-Allow-Origin header and
   * reports 0 bytes for every control / replica / query call. That makes
   * cross-origin BYTES unmeasurable here — but not cross-origin REQUESTS,
   * which are counted honestly. Without this key an app open could fire any
   * number of extra gateway round-trips completely unfenced, which is the
   * regression an inline app is most likely to introduce.
   */
  maxTotalRequests: number;
}

export interface ShellBudget extends OpenBudget {
  /**
   * A warm reload must serve the shell bundle from the SW/HTTP cache — the
   * transferred bytes collapse to a small fraction of the cold load.
   */
  maxWarmToColdByteRatio: number;
}

export interface PerfBudgets {
  /** The shell page (Vite bundles + tokens) measured COLD on the app origin (4173). */
  shell: ShellBudget;
  /**
   * An inline app route open, measured as the SAME-ORIGIN tail of the shell
   * page's own resource timeline between the palette click and the mounted app
   * (issue #799 retired the served-app iframe, so there is no second window and
   * no navigation entry). What it fences is the shell's per-app lazy-chunk
   * cost: the app's `app-inline` chunk, its CSS, and whatever shared chunks it
   * is the first route to pull in.
   */
  appOpen: {
    cold: AppOpenBudget;
    warm: AppOpenBudget;
    /**
     * Warm re-open must load far fewer bytes than cold. On the inline path the
     * module registry already holds the descriptor, so a healthy re-open pulls
     * NOTHING — the ratio (over `encodedBodySize`, since wire bytes are 0 on
     * both sides behind the SW cache) sits at 0 and the ceiling catches a
     * change that makes re-opening an app re-pay its payload. Ratio, not
     * absolute, so it survives fixture changes.
     */
    maxWarmToColdByteRatio: number;
  };
  /**
   * Test B — the service-worker TUNNEL cache. A warm re-open through the
   * virtual iroh route must be served from the SW cache: the number of bridge
   * round trips and the tunnel-fetched bytes both collapse. This is the
   * wave-1 SW-caching win the probe exists to fence.
   */
  swTunnelCache: {
    maxWarmToColdByteRatio: number;
    maxWarmToColdRequestRatio: number;
  };
  /**
   * Test C — the QUIC connection pool. Across N tunnel requests the transport
   * must reuse one endpoint CONNECT for many request STREAMS, so
   * connects / streams stays well under 1. Proves the pooling win.
   */
  irohPool: {
    maxConnectToStreamRatio: number;
    /** A pooled multi-request run must show at least this many streams. */
    minStreamsForProof: number;
  };
  /** Soft, log-only wall-clock ceilings (ms). Never fail the build. */
  timing: {
    coldOpenMsSoftCeiling: number;
    warmOpenMsSoftCeiling: number;
  };
}

// -----------------------------------------------------------------------------
// MEASURED BASELINE — apps/web e2e harness, headless Chromium, 2026-07-14.
// See the report table in the task summary / scripts/perf/README.md. Headroom
// rationale is inline on each number.
// -----------------------------------------------------------------------------
// Re-baselined 2026-07-27 for Vite 8 (#565). Vite 8 moved the bundler to
// rolldown, which splits the shell into more, smaller chunks than Vite 7 did.
//
// Measured on the SAME e2e harness, main (051658de, Vite 7) vs this branch:
//
//   requests   8 -> 15 unmitigated -> 12 with chunk grouping
//   transfer   402,997 B -> 387,990 B   (-3.7%)
//
// Read the request number honestly: 12 is still +4 on Vite 7 for a ~4% byte
// saving. It is not a win, it is a partly-repaid regression. (The 1,041,444 B
// figure in the old comment below predated the brotli precompression added by
// #460 on 2026-07-19; comparing against it overstates the result by ~60 points.
// 402,997 B is the like-for-like number.)
//
// The 15 -> 12 came from a `shell-common` group in apps/web/vite.config.ts.
// Going lower is blocked on source, not config: `apps/web/src/web-host.ts`
// assigns `window.CentraidApi` at module-evaluation time, so any grouping wide
// enough to fold in the remaining chunks reorders its consumers ahead of it and
// ships a BLANK PAGE. Two such shapes were built and measured — both reported
// only 6 requests / 221 KB, i.e. the naive metric *improved* while the app was
// dead. That is why perf-waterfall.spec.ts asserts the app renders, and why any
// future chunking work must keep that assertion in front of these budgets.
//
// `maxRequests` still rises 10 -> 13 (ratchet calls that a widen, hence the
// approvedDeviation below), but 13 rather than the 18 an unmitigated
// re-baseline would have needed. `maxTransferBytes` tightens 1,250,000 ->
// 470,000 in the same edit — a genuine tightening against both measurements.
export const approvedDeviation =
  "Binding Layer font fan-out re-baseline in #707/#708/#709. CI web-e2e on PR #709 head 88ab442f measured cold same-origin shell requests=16 transfer=495485B (PWA WATERFALL SUMMARY). The +4 requests / +~74 KB vs the prior 12 / 470_000 ceilings were the ten self-hosted woff2 faces served from /fonts by the centraid-fonts Vite plugin; they are intentional product identity, not accidental chunk bloat. v8 cuts that fan-out to FOUR files (Instrument Sans 400/600, latin + latin-ext); Source Serif 4 and the 500 cut are withdrawn, numerics remain tabular Sans, and code takes the platform stack, which downloads nothing. The ceilings below are NOT re-baselined here, because they are measured in CI rather than derived: the next web-e2e run should measure the smaller payload before this ratchet is tightened. Prior Vite 8 note (#565) still holds for JS chunking: going below the JS half still needs a web-host.ts source change. maxRequests widens 12 -> 17 (measured 16 + 1); maxTransferBytes widens 470_000 -> 520_000 (measured 495_485 + ~5% headroom). #738 adds the durable pending-write read/presentation engine to the common shell; PR #745 CI measured 525304B before its replacement path was split behind retry/edit. Maintainer-approved maxTransferBytes 520_000 -> 528_000 preserves a 2696B ceiling above that measured run while keeping request count and all app-open/warm budgets unchanged. Tighten when the shared pending metadata grammar or font payload is reduced. #799 stage 2 RE-SEEDS the appOpen budgets, because the subject changed rather than regressed: the served-app iframe is deleted, so an app open is now a dynamic import of an inline route's lazy chunk inside the shell window, measured as the same-origin tail of the shell's own resource timeline. Measured (local `bun run --cwd apps/web build` dist, headless Chromium, 2026-08-15) opening Tasks: cold 8-9 requests / 0 transfer B / 112_759 encoded B, warm 0 requests / 0 B. Two ceilings WIDEN and are the whole of the deviation: appOpen.cold.maxRequests 8 -> 10 (the old 8 fenced a fixture iframe with ZERO subresources; the inline route legitimately pulls eight same-origin chunks, plus a ninth worker entry that races the mark) and, structurally, the byte fence moves onto a new `maxEncodedBytes` key (120_000 cold) because `transferSize` is 0 for anything the service worker answers from Cache Storage and so can no longer fence weight at all. Everything else TIGHTENS in the same edit: appOpen.warm.maxRequests 8 -> 2, both maxTransferBytes 20_000 -> 8_000 (measured 0; the ceiling now fences 'an open must not go back to the network'), and maxWarmToColdByteRatio 1.2 -> 0.1 (the 1.2 existed only because the retired app document was no-store and re-transferred in full every open). DISCLOSE THE SCOPE CHANGE, because the ratchet cannot see it: main asserted app-open requests and bytes over ALL origins; the re-pointed spec asserts them over SAME-ORIGIN only. warm.maxRequests 8 -> 2 and both maxTransferBytes 20_000 -> 8_000 are therefore measured against a strictly smaller population, so they are not the pure tightenings their numbers suggest. Same-origin is the right subject (the harness gateway answers on another port with no Timing-Allow-Origin header, so every control/replica/query call reports 0 bytes and would dilute the total), but it would have left cross-origin traffic unfenced entirely, so a new maxTotalRequests key gates the ALL-ORIGIN count instead: cold 30, warm 14, from measured 20-24 and 6-9 over 13 runs. Cross-origin BYTES remain unfenced and unfenceable in this harness; that is a known limit of the rig, not a budget decision. A new minEncodedBytes floor (cold 90_000, an up-only ratchet) replaces the bare '> 0' anti-vacuity check, which fenced only exactly-zero and so would not have caught the realistic failure — the app chunk getting preloaded or folded into `boot`, leaving one incidental byte in the window while every ceiling passed. The mark is now taken after the palette's own chunks settle: without that, cold read 112_759 B with an occasional 179_759 B outlier as an in-flight palette chunk was charged to the app open. Re-measure and tighten maxEncodedBytes when the shared inline chunk graph shrinks. #800 re-seeds minEncodedBytes 90_000 -> 70_000 from CI linux web-e2e on PR #800 run 31921007894 (head 3122163cd): cold same-origin encoded=80561 B on both the first run and retry, while the 90_000 floor was taken from a local darwin 112_759 B measurement. 70_000 sits ~13% under the CI number — still well above an incidental byte or a missing app-inline chunk (~52 KB) — so the anti-vacuity check stays load-bearing. The 120_000 ceiling is unchanged. #676 changes the app-open SUBJECT, Tasks -> Docs, and widens ONE ceiling with it: appOpen.cold.maxEncodedBytes 120_000 -> 240_000. This is not a regression being waved through. #831 removed the Agenda/Notes/Tally/Tasks interfaces wholesale pending a ground-up redesign, so Tasks' Root now paints one empty element; the probe kept opening Tasks and measured 7_346 encoded B, which tripped the 70_000 minEncodedBytes floor exactly as that floor was designed to. #831 had already retargeted the desktop and web offline journeys onto Docs for this reason and did not reach this spec. Repointing it onto Docs restores a real subject; the 120_000 ceiling then no longer describes anything, because it fenced an app that has no interface left to download. MEASURED first open of Docs (local linux headless Chromium, 2026-08-20, fresh `bun run build` dist): 216_625 encoded B over 8 same-origin chunks (app-inline 138_565, app-inline CSS 44_223, view-state-kit 16_857 + 1_629 CSS, untrusted 6_775, PendingWriteActions 5_900 + 2_530 CSS, shared-copy 146). 240_000 is measured + ~11%; the headroom is wider than the ~6% used elsewhere in this file because the local/CI spread on this exact metric is known to be large (#800 recorded local darwin 112_759 B against CI linux 80_561 B on the old subject). TIGHTEN once a CI run publishes the Docs number. Everything else in the same-origin appOpen block is re-checked against Docs and UNCHANGED: cold.maxRequests 10 (measured 8), cold.maxTransferBytes 8_000 (measured 0), warm.maxRequests 2 / warm.maxTransferBytes 8_000 / warm.maxEncodedBytes (all measured 0), and maxWarmToColdByteRatio 0.1 (measured 0). The two all-origin maxTotalRequests keys DO move, and are itemised further down. minEncodedBytes is deliberately NOT raised to match the bigger subject: 70_000 stays load-bearing against Docs (losing its 138_565 B app-inline chunk still trips it) and seeding a floor from an unverified local number is how this rig starts flaking. Separately, #676 widens shell.maxRequests 17 -> 18, and the record of HOW is the point. The 18th request is the pdfjs `?url` worker-URL module — a chunk whose entire body is one 35-character string — pinned into `boot` by static imports in device-enrichment-compute.ts and docs/pdf-text.ts. Removing it was attempted first, not second: making both imports dynamic does take the cold shell to exactly 17. It also BREAKS the desktop offline journey. Dropping that static edge re-partitions the boot chunk graph, and apps/desktop/tests/e2e/pending-overlay.spec.ts ('a production Docs row queued offline survives an Electron reload') then fails on the reload taken under context().setOffline(true), with Docs painting 'No vault access yet.' — a boot-critical module has moved behind a chunk fetch that cannot complete with the network severed. Established by bisection against a pristine origin/main worktree: main passes the journey, both-lazy fails it, and docs/pdf-text.ts made lazy ALONE passes while leaving the shell at 18 — so the device-enrichment edge is the single one that both removes the request and breaks offline. Offline correctness is a product promise; one 411-byte request is not. Both source files are therefore reverted to main byte-for-byte and the ceiling moves instead. shell.maxTransferBytes is untouched (measured 447_517 B against 528_000). TIGHTEN back to 17 with a bundling change that keeps the worker-URL module out of `boot` without splitting the offline-critical boot graph. Two further #676 re-seeds belong to the same Tasks -> Docs subject change, both on the all-origin request fences that the same-origin byte budgets structurally cannot see. MEASURED over 10 local runs on Docs: cold all-origin 20-28 (Tasks: 20-24), warm all-origin 10-16 (Tasks: 6-9). appOpen.cold.maxTotalRequests 30 -> 36 and appOpen.warm.maxTotalRequests 14 -> 24, each observed max plus the headroom its own prior number used (~25% cold, ~55% warm). Docs is a heavier app that makes more replica/control/query round-trips on open; the counts are the bootstrap racing the mark, not an app firing round-trips by the dozen, which is what these fences exist to catch and what 36/24 still catch. Note the cold fence was not merely stale: 30 sat two above an observed 28, so it would have flaked in CI on the new subject rather than failing honestly. FINALLY, and unrelated to any budget number, #676 fixes a real ~1-in-4 flake this spec had independent of the subject: establishSession() reloaded for the WARM shell measurement and only then waited for `navigator.serviceWorker.controller`, so the reload raced SW activation and sometimes ran uncontrolled. Hashed assets survived that on the browser HTTP cache at 0 wire bytes, but the sqlite worker script did not — it returned over the wire at 67_300 B and drove shell.maxWarmToColdByteRatio to 0.1505 against its 0.15 ceiling. The wait now happens BEFORE the reload (and the timeline settles after it, as the cold path already did), so the warm load is genuinely service-worker-served — which is what that ratio claims to prove. Measured 0.0 on 18 consecutive local runs afterwards. No ratio ceiling was touched.";

export const perfBudgets: PerfBudgets = {
  shell: {
    // MEASURED cold shell (same-origin, 4173) on PR #709 Binding Layer head
    // (88ab442f, CI client-e2e / web-e2e): 16 requests / 495_485 B.
    //
    // Prior ceiling was 12 / 470_000 after Vite 8 + #659. The Binding Layer
    // adds ten same-origin woff2 faces under /fonts (four families, latin +
    // latin-ext subsets; Sans also ships weight 500). Resource timing counts
    // each face; transfer includes their compressed bodies. That is product
    // identity load, not a JS-chunk regression — see approvedDeviation.
    //
    // Ceiling = measured + 1 request / ~5% byte headroom for CI jitter.
    //
    // WIDENED 17 -> 18 (#676). The 18th request is the pdfjs `?url` worker-URL
    // module — a chunk whose entire body is one 35-character string — pulled
    // into `boot` by the static imports in packages/client/src/
    // device-enrichment-compute.ts and packages/blueprints/apps/docs/
    // pdf-text.ts. It is waste, and removing it was tried FIRST: making both
    // imports dynamic does take the cold shell to exactly 17. It also breaks
    // the desktop offline journey. Dropping that static edge re-partitions the
    // boot chunk graph, and `pending-overlay.spec.ts` ("a production Docs row
    // queued offline survives an Electron reload") then fails on a reload taken
    // under `context().setOffline(true)`: Docs paints "No vault access yet."
    // because a boot-critical module has moved behind a chunk fetch that
    // cannot complete with the network severed. Verified by bisection — with
    // only docs/pdf-text.ts made lazy the journey passes and the shell stays at
    // 18; the device-enrichment edge is the one that both removes the request
    // and breaks offline. Offline correctness is a product promise and one
    // 411-byte request is not, so the request stays and this ceiling moves.
    // TIGHTEN back to 17 with a bundling change that keeps the worker-URL
    // module out of `boot` WITHOUT splitting the offline-critical boot graph.
    maxRequests: 18,
    // MEASURE IT THE SAME WAY OR THE NUMBER IS MEANINGLESS: `transferSize` is
    // the COMPRESSED size, and `scripts/perf/run-waterfall.mjs` runs a bare
    // `vite build`, which skips `scripts/precompress.mjs` while `emptyOutDir`
    // deletes any sidecars a previous full build left. Measuring that way reads
    // ~1.79 MB here — uncompressed serving, not a regression. Run
    // `bun run --cwd apps/web build` first, then the spec.
    // #738 approved deviation: measured 525_304 B in PR #745 CI. Keep the
    // documented safe common-shell chunk order; the companion budgets hold.
    maxTransferBytes: 528_000,
    // MEASURED warm/cold ratio ~0.0 (served from cache). 0.15 leaves room for
    // an unavoidable no-store fetch or two while still proving the shell cache.
    maxWarmToColdByteRatio: 0.15,
  },
  appOpen: {
    cold: {
      // SUBJECT CHANGED, Tasks -> Docs (#676). #831 removed the Tasks
      // interface wholesale pending a redesign, so the probe's lazy chunk fell
      // to 7_346 B and tripped `minEncodedBytes` — the floor catching exactly
      // the vacuity it was written for. The fix is a real subject, not a lower
      // floor: the spec now opens Docs, as #831 already did for the offline
      // journeys. Only `maxEncodedBytes` moves with it (see below); every other
      // ceiling here was re-checked against Docs and holds unchanged.
      //
      // Historical note, kept because the numbers below still cite it:
      // RE-SEEDED for the inline app route (#799) — rationale in
      // approvedDeviation above. MEASURED first open of Tasks against a fresh
      // `bun run --cwd apps/web build` dist: 0 transfer bytes and 112_759
      // encoded bytes across eight deterministic same-origin chunks (the
      // app-inline chunk 52_192 B, its CSS 13_498 B, `untrusted` 42_913 B,
      // plus scope-merge / scope-kit / search-scaffold / PendingWriteActions /
      // LoadingSkeleton). A ninth entry — the sqlite worker script, 0 encoded
      // bytes — lands on either side of the pre-open mark depending on how the
      // replica bootstrap races, so the observed count is 8 or 9.
      //
      // Read `maxEncodedBytes` as UNCOMPRESSED weight: Cache Storage holds
      // decoded bodies, so `encodedBodySize` for an SW-served chunk is its raw
      // size. It is a weight ratchet, not a wire-cost estimate.
      //
      // Ceilings = measured + 1 request / ~6% byte headroom for CI jitter.
      maxRequests: 10,
      // Measured 0: the SW precache crawl (apps/web/public/sw.js) finishes
      // during install, and the probe waits for `serviceWorker.controller`
      // before opening, so every chunk is answered from Cache Storage. The
      // ceiling is not 0 because a single conditional revalidation is legal;
      // it is small enough that re-fetching one app chunk fails the build.
      maxTransferBytes: 8_000,
      // WIDENED 120_000 -> 240_000, and it is a subject change rather than a
      // regression: the 120_000 fenced Tasks, which no longer has an interface
      // to download. MEASURED first open of Docs (local linux headless
      // Chromium, 2026-08-20, fresh `bun run build` dist): 216_625 encoded
      // bytes over 8 same-origin chunks — app-inline 138_565 B, its CSS
      // 44_223 B, view-state-kit 16_857 B + 1_629 B CSS, untrusted 6_775 B,
      // PendingWriteActions 5_900 B + 2_530 B CSS, shared-copy 146 B. Docs is
      // simply a bigger interface than Tasks was; none of it is PDF.js, whose
      // display build has always loaded behind a dynamic import in
      // packages/blueprints/apps/docs/pdf-text.ts and is untouched here.
      //
      // 240_000 is measured + ~11%, wider than the ~6% used elsewhere in this
      // block because the local/CI delta on this metric is known to be large:
      // #800 recorded local darwin 112_759 B against CI linux 80_561 B for the
      // same open. TIGHTEN once a CI run publishes the Docs number.
      maxEncodedBytes: 240_000,
      // Floor: UNCHANGED at 70_000 across the Tasks -> Docs subject change.
      // It could be raised — Docs measures 216_625 B locally, three times this
      // — but the #800 note records a local/CI spread wide enough (112_759 vs
      // 80_561 on the old subject) that a floor seeded from an unverified local
      // number is how this rig starts flaking. 70_000 stays load-bearing on the
      // new subject anyway: it is far above the 7_346 B hollow-app reading that
      // exposed the stale subject, and losing the Docs app-inline chunk
      // (138_565 B) from the measurement still trips it. Raise it once CI has
      // published a Docs number to seed from.
      //
      // Prior rationale (Tasks): CI linux (PR #800 run 31921007894) measured
      // 80_561 on both the first run and retry; the 90_000 before that was
      // seeded from a local darwin 112_759 B run that CI does not reproduce.
      minEncodedBytes: 70_000,
      // RE-SEEDED for Docs (#676): MEASURED all-origin 20-28 across 10 local
      // runs, against 20-24 for Tasks. The spread is the replica bootstrap's
      // control/query traffic racing the mark, not app weight, and Docs simply
      // makes more of it. 36 = observed max 28 + ~25% headroom, the same
      // methodology the Tasks number used. The old 30 was NOT merely stale —
      // it sat 2 above an observed 28, so it would have flaked in CI on the new
      // subject. Loose by design: its job is to catch an open that starts
      // firing round-trips by the dozen, which the same-origin byte fences
      // structurally cannot see.
      maxTotalRequests: 36,
    },
    warm: {
      // MEASURED warm re-open: 0 requests, 0 bytes of either kind — the
      // descriptor and every chunk it pulled are already in the module
      // registry, so a re-open loads nothing at all. The ceilings leave room
      // for one or two small chunks rather than demanding an exact zero.
      maxRequests: 2,
      maxTransferBytes: 8_000,
      maxEncodedBytes: 8_000,
      // A warm re-open legitimately loads nothing, so there is no weight to
      // floor — 0 keeps the key uniform across cold/warm without asserting a
      // fiction. The cold floor is the one that keeps the rig honest.
      minEncodedBytes: 0,
      // RE-SEEDED for Docs (#676): MEASURED all-origin 10-16 across 10 local
      // runs, against 6-9 for Tasks. 24 = observed max 16 + ~55% headroom, the
      // same methodology the Tasks number used. A warm re-open does no
      // same-origin work at all, so this is the only fence left on it.
      maxTotalRequests: 24,
    },
    // MEASURED 0.0 — a warm re-open re-pays none of the app's payload. The
    // ceiling catches a change that makes it re-pay some. (The old 1.2 existed
    // because the retired served-app document was `no-store` and re-transferred
    // in full on every open; nothing on the inline path does that.)
    maxWarmToColdByteRatio: 0.1,
  },
  swTunnelCache: {
    // Warm tunnel-fetched bytes < 20% of cold — the SW serves assets/blobs
    // from cache and only a conditional revalidation (or nothing) reaches the
    // relay. This is the headline wave-1 assertion.
    maxWarmToColdByteRatio: 0.2,
    // Both assets and blobs revalidate authorization conditionally. Warm
    // calls may equal cold calls, but must transfer almost no response bytes.
    maxWarmToColdRequestRatio: 1,
  },
  irohPool: {
    // Many streams, ~1 connect → ratio ≪ 1. 0.5 leaves room for an
    // occasional forced reconnect while still proving pooling.
    maxConnectToStreamRatio: 0.5,
    minStreamsForProof: 3,
  },
  timing: {
    // Generous — headless CI wall clock for one inline app open (palette click
    // → mounted app), which on a cold open includes the replica handshake.
    coldOpenMsSoftCeiling: 15_000,
    warmOpenMsSoftCeiling: 8_000,
  },
};

/**
 * Timing budgets are enforced (issue #468 L5). Soft log-only mode was the
 * previous default; CI now fails when cold/warm open exceed the ceilings in
 * `perfBudgets.timing`. Request/byte budgets remain hard gates too.
 */
export const enforceTiming = true;
