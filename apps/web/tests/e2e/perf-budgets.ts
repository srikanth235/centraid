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
// Timing budgets are intentionally SOFT (log-only, see `enforceTiming`): wall
// clock on a shared CI runner is the flakiest signal, so request-count and
// byte budgets are the hard gates and timing is advisory until proven stable.

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
export const perfBudgets: PerfBudgets = {
  shell: {
    // MEASURED cold shell (same-origin, 4173): 6 requests (index.html,
    // index-*.js, boot-*.js, tokens/css chunks). Ceiling = measured + headroom
    // for a chunk the bundler may split out. If bundling REDUCES this, tighten.
    maxRequests: 10,
    // MEASURED cold same-origin shell transfer ~1,041,444 B (boot-*.js
    // dominates: 708 KB raw). Ceiling = measured + ~20%. The bundling
    // workstream should push this DOWN — re-measure and tighten when it lands.
    maxTransferBytes: 1_250_000,
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
