// Metro-side concerns for the mobile agent-e2e harness: is the packager up, and
// is the JS bundle already built before a flow starts its clock.
//
// Split out of harness.mjs, which sits against the 500-line repo cap; these two
// functions are the one cohesive piece that stands alone. `appId` is passed in
// rather than imported so this module has no edge back to harness.mjs.

// The Expo dev build fetches its JS bundle from Metro at runtime. If
// clearState wipes the cached bundle and Metro isn't reachable, the
// app shows a redbox ("No script URL provided") and every `assertVisible`
// times out cryptically. Fail loudly instead.
export async function metroReachable() {
  try {
    const res = await fetch('http://127.0.0.1:8081/status', {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Query string the Expo dev client actually asks Metro for.
 *
 * This must stay byte-for-byte what the running app requests, because Metro
 * keys its serializer cache on the *whole* option set — most importantly
 * `transform.engine`, `transform.bytecode` and `unstable_transformProfile`.
 * A bundle built under different transform options warms a different cache
 * namespace and buys the app almost nothing.
 *
 * Captured from Metro's own request log by launching the dev build against
 * `expo start --dev-client` (DEBUG=expo:*); re-capture it the same way if an
 * Expo/RN upgrade changes the dev client's URL.
 *
 * Measured on this repo against a cold Metro cache (M-series Mac):
 *   - prewarming `platform=ios&dev=true&minify=false` (the old value) left the
 *     app's own launch fetch costing 7s of a 10s cold build — a ~30% saving.
 *   - prewarming this exact query leaves the app's launch fetch at 0s.
 * The nightly macOS runner is roughly 5x slower (its prewarm of a comparable
 * graph measured 52s), so the old value left ~35s of bundling *inside* the
 * first `extendedWaitUntil` — precisely the cost the prewarm exists to remove.
 */
function devClientBundleQuery(platform, appId) {
  return [
    `platform=${platform}`,
    'dev=true',
    'lazy=true',
    'minify=false',
    'inlineSourceMap=false',
    'modulesOnly=false',
    'runModule=true',
    'excludeSource=true',
    'sourcePaths=url-server',
    `app=${appId}`,
    'transform.routerRoot=app',
    'transform.engine=hermes',
    'transform.bytecode=1',
    'unstable_transformProfile=hermes-stable',
  ].join('&');
}

// Build the JS bundle once, before any flow starts its clock.
//
// Every flow opens with `launchApp: { clearState: true }`, which drops the dev
// build's cached bundle, so the app refetches it from Metro on that first launch.
// If Metro's transform cache is also cold — as it is on a fresh CI runner — that
// build lands *inside* the flow's first `extendedWaitUntil` and eats the whole
// budget. Paying it here keeps flow timeouts about the app, not about bundling.
//
// Best-effort by design: a failure here is not a flow failure. If the bundle is
// genuinely broken the flow's own assertions will say so, with a screenshot.
export async function prewarmMetroBundle(platform, appId) {
  // Metro's project root is the monorepo root (Expo runs from the workspace
  // bin), so the app's entry is served at `apps/mobile/index.ts` — plain
  // `/index.bundle` 404s here. `/.expo/.virtual-metro-entry.bundle` answers 200
  // but builds a 1-module stub, which is why the size floor below matters: a
  // 200 alone does not mean the real graph was built.
  const query = devClientBundleQuery(platform, appId);
  const candidates = [
    `http://127.0.0.1:8081/apps/mobile/index.bundle?${query}`,
    `http://127.0.0.1:8081/index.bundle?${query}`,
  ];
  const MIN_REAL_BUNDLE_BYTES = 1_000_000;
  for (const url of candidates) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      // Drain the body: Metro streams the bundle and isn't done building until
      // the last byte is out.
      const bytes = (await res.arrayBuffer()).byteLength;
      if (!res.ok || bytes < MIN_REAL_BUNDLE_BYTES) continue;
      console.log(`  prewarm : bundle ready in ${Date.now() - t0}ms (${bytes} bytes)`);
      return;
    } catch (err) {
      console.log(`  prewarm : ${url.split('?')[0]} failed (${err.message ?? err})`);
    }
  }
  console.log('  prewarm : no bundle endpoint matched — flows will pay the cold build');
}
