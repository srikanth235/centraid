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
// The harness app (`web-e2e`) is a deliberately tiny fixture, so the absolute
// numbers are small. Their VALUE is the methodology + the regression fence:
// the ratios (warm-vs-cold, connect-vs-stream) hold regardless of app size,
// and the absolute ceilings move with the fixture, not with production apps.
//
// Timing budgets hard-fail when `enforceTiming` is true (issue #468 L5).
// Request-count and byte budgets remain hard gates regardless.

export interface OpenBudget {
  /** Max resource-timing entries (`performance.getEntriesByType('resource')`). */
  maxRequests: number;
  /** Max summed `transferSize` in bytes for SAME-ORIGIN resources. */
  maxTransferBytes: number;
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
  /** The generated-app iframe, measured from inside the iframe's own origin. */
  appOpen: {
    cold: OpenBudget;
    warm: OpenBudget;
    /**
     * Warm re-open must transfer far fewer bytes than cold — a working
     * validator cache (ETag/304 on the gateway HTTP path) collapses the
     * transferred body to conditional-request overhead. Ratio, not absolute,
     * so it survives fixture changes.
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
  "Binding Layer font fan-out re-baseline in #707/#708/#709. CI web-e2e on PR #709 head 88ab442f measured cold same-origin shell requests=16 transfer=495485B (PWA WATERFALL SUMMARY). The +4 requests / +~74 KB vs the prior 12 / 470_000 ceilings are the ten self-hosted woff2 faces (Instrument Sans 400/500 × latin/latin-ext, Instrument Serif, Source Serif 4, DM Mono — each latin + latin-ext) served from /fonts by the centraid-fonts Vite plugin; they are intentional product identity, not accidental chunk bloat. Prior Vite 8 note (#565) still holds for JS chunking: going below the JS half still needs a web-host.ts source change. maxRequests widens 12 -> 17 (measured 16 + 1); maxTransferBytes widens 470_000 -> 520_000 (measured 495_485 + ~5% headroom). #738 adds the durable pending-write read/presentation engine to the common shell; PR #745 CI measured 525304B before its replacement path was split behind retry/edit. Maintainer-approved maxTransferBytes 520_000 -> 528_000 preserves a 2696B ceiling above that measured run while keeping request count and all app-open/warm budgets unchanged. Tighten when the shared pending metadata grammar or font payload is reduced.";

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
    maxRequests: 17,
    // MEASURE IT THE SAME WAY OR THE NUMBER IS MEANINGLESS: `transferSize` is
    // the COMPRESSED size, and `scripts/perf/run-waterfall.mjs` runs a bare
    // `vite build`, which skips `scripts/precompress.mjs` while `emptyOutDir`
    // deletes any sidecars a previous full build left. Measuring that way reads
    // ~1.79 MB here — uncompressed serving, not a regression. Run
    // `bun run --cwd apps/web build` first, then the spec.
    // #738 approved deviation: measured 525_304 B in PR #745 CI; the immutable
    // replacement implementation is additionally lazy-loaded after that run.
    maxTransferBytes: 528_000,
    // MEASURED warm/cold ratio ~0.0 (served from cache). 0.15 leaves room for
    // an unavoidable no-store fetch or two while still proving the shell cache.
    maxWarmToColdByteRatio: 0.15,
  },
  appOpen: {
    cold: {
      // MEASURED cold app iframe (web-e2e fixture): 0 subresource requests, the
      // no-store HTML doc is ~1978 B of navigation transfer (runtime is inlined,
      // no external assets). The request-count ceiling is the real fence here.
      // The byte ceiling is deliberately generous — a bare fixture doc — so a
      // heavier real app or the bundling workstream lands without a spurious
      // red; re-measure and TIGHTEN both when a richer app fixture is wired.
      maxRequests: 8,
      maxTransferBytes: 20_000,
    },
    warm: {
      // Warm re-open: the app HTML is no-store (per-response nonce) so the doc
      // re-transfers (~1977 B); any cacheable subresource is served from cache.
      maxRequests: 8,
      maxTransferBytes: 20_000,
    },
    // The web-e2e HTML is no-store, so its doc bytes re-transfer every open —
    // the warm/cold total ratio stays near 1 for THIS fixture. 1.2 tolerates
    // that while catching a regression that INFLATES the warm open. The
    // aggressive cache proof lives in the SW-tunnel path (swTunnelCache, 0.2).
    maxWarmToColdByteRatio: 1.2,
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
    // Generous — headless CI cold open of the shell + iframe. Log-only.
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
