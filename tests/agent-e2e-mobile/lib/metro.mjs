// Metro-side concerns for the mobile agent-e2e harness: is the packager up, and
// is the JS bundle already built before a flow starts its clock.
//
// Split out of harness.mjs, which sits against the 500-line repo cap; these two
// functions are the one cohesive piece that stands alone. `appId` is passed in
// rather than imported so this module has no edge back to harness.mjs.

// Metro's port. 8081 is Expo's default and what CI uses; every Metro URL in the
// harness derives from here so an override is one env var
// (`METRO_PORT=8082 node tests/agent-e2e-mobile/flows/<flow>.mjs`).
//
// Overriding it does NOT move the app: this project has no `expo-dev-client`
// dependency, so the iOS debug build asks `RCTBundleURLProvider` for
// `localhost:8081` — a port baked in at BUILD time (`RCT_METRO_PORT`), not
// discoverable at run time, and the `centraid://` scheme has no
// `expo-development-client` deep link to redirect it. A second worktree that
// starts Metro elsewhere gets a "No script URL provided" redbox on the phone
// while this preflight reports the packager healthy. So: on iOS, either free
// 8081 for the worktree under test or rebuild with `RCT_METRO_PORT`. The
// override is genuinely useful on Android, where `adb reverse` maps whatever
// port is chosen back to the emulator's `localhost:<port>`.
export const METRO_PORT = Number(process.env.METRO_PORT ?? 8081);
export const METRO_ORIGIN = `http://127.0.0.1:${METRO_PORT}`;
// CI's embedded-bundle lane builds the JS bundle into the Release .app. It
// deliberately has no Metro dependency; keeping the mode in this module lets
// the flow snippets and harness share one explicit switch.
export const MOBILE_E2E_EMBEDDED = process.env.MOBILE_E2E_EMBEDDED === "1";

/**
 * Deep link that tells the Expo dev client WHICH experience to load.
 *
 * Since #723 the debug build ships `expo-dev-client`, whose launcher activity
 * owns every cold start. A plain icon launch shows its server picker, and the
 * picker's discovery never lists this repo's Metro on a CI emulator/simulator
 * — the app would sit on "DEVELOPMENT SERVERS" until every assertion times out
 * (the 2026-08-05..08-23 nightly red). Opening this link hands the launcher the
 * explicit bundle URL; afterwards plain relaunches auto-resume that last
 * session, so only cleared-state launches need it (`pm clear` / clearState
 * wipes the stored "last opened" URL along with everything else).
 *
 * The scheme is the app's own (`scheme: "centraid"` in app.config.ts), which
 * both platforms register for exactly this host — AndroidManifest.xml's VIEW
 * intent filter and Info.plist's CFBundleURLSchemes.
 */
export const DEV_LAUNCHER_LINK = `centraid://expo-development-client/?url=${encodeURIComponent(METRO_ORIGIN)}`;

// The Expo dev build fetches its JS bundle from Metro at runtime. If
// clearState wipes the cached bundle and Metro isn't reachable, the
// app shows a redbox ("No script URL provided") and every `assertVisible`
// times out cryptically. Fail loudly instead.
export async function metroReachable() {
  try {
    const res = await fetch(`${METRO_ORIGIN}/status`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const pause = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

/**
 * Wait through Metro's transient startup/reload window before declaring the
 * environment broken.
 *
 * Expo can answer `/status` once and then briefly stop accepting requests while
 * its file graph settles. The workflow's initial curl therefore cannot be the
 * harness's only readiness proof. Keep this bounded: a genuinely dead Metro
 * process must still fail setup instead of turning into a flow timeout.
 */
export async function waitForMetroReachable({
  attempts = 30,
  intervalMs = 1_000,
  probe = metroReachable,
  sleep = pause,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- readiness probes must be sequential
    if (await probe()) return true;
    // oxlint-disable-next-line no-await-in-loop -- the delay separates readiness probes
    if (attempt < attempts) await sleep(intervalMs);
  }
  return false;
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
    "dev=true",
    "lazy=true",
    "minify=false",
    "inlineSourceMap=false",
    "modulesOnly=false",
    "runModule=true",
    "excludeSource=true",
    "sourcePaths=url-server",
    `app=${appId}`,
    "transform.routerRoot=app",
    "transform.engine=hermes",
    "transform.bytecode=1",
    "unstable_transformProfile=hermes-stable",
  ].join("&");
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
    `${METRO_ORIGIN}/apps/mobile/index.bundle?${query}`,
    `${METRO_ORIGIN}/index.bundle?${query}`,
  ];
  const MIN_REAL_BUNDLE_BYTES = 1_000_000;
  // Fallback URLs must be tried in priority order; the first complete bundle
  // establishes the Metro warmup result.
  const prewarmNext = async (index) => {
    const url = candidates[index];
    if (!url) return false;
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      // Drain the body: Metro streams the bundle and isn't done building until
      // the last byte is out.
      const bytes = (await res.arrayBuffer()).byteLength;
      if (!res.ok || bytes < MIN_REAL_BUNDLE_BYTES)
        return prewarmNext(index + 1);
      console.log(
        `  prewarm : bundle ready in ${Date.now() - t0}ms (${bytes} bytes)`
      );
      return true;
    } catch (error) {
      console.log(
        `  prewarm : ${url.split("?")[0]} failed (${error.message ?? error})`
      );
      return prewarmNext(index + 1);
    }
  };
  if (!(await prewarmNext(0)))
    console.log(
      "  prewarm : no bundle endpoint matched — flows will pay the cold build"
    );
}
