export const METRO_PORT = Number(process.env.METRO_PORT ?? 8081);
export const METRO_ORIGIN = `http://127.0.0.1:${METRO_PORT}`;

export const DEV_LAUNCHER_LINK = `centraid://expo-development-client/?url=${encodeURIComponent(METRO_ORIGIN)}`;

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

export async function prewarmMetroBundle(platform, appId) {
  const query = devClientBundleQuery(platform, appId);
  const candidates = [
    `${METRO_ORIGIN}/apps/mobile/index.bundle?${query}`,
    `${METRO_ORIGIN}/index.bundle?${query}`,
  ];
  const MIN_REAL_BUNDLE_BYTES = 1_000_000;
  const prewarmNext = async (index) => {
    const url = candidates[index];
    if (!url) return false;
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
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
