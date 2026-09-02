// The demo corpus, and WHEN it has to exist (#905).
//
// THE RULE THIS MODULE EXISTS TO KEEP: the corpus must be in the gateway before
// the phone's FIRST replica clone. Seeding after it is not late-but-fine, it is
// invisible — `ctx.ensureDemo` only writes to the gateway, and nothing pulls a
// post-clone write down to a phone that is already paired.
//
// HOW THAT BROKE, because the shape is worth recognising again. Every flow does
// the right thing on its own:
//
//     await ctx.ensureDemo("notes");   // seed
//     await ctx.configureGateway();    // then pair
//
// but a LANE is many flows sharing one pairing. `run-pr-gate-suite` opens with
// `pairing-canary`, which pairs and seeds nothing; the roster lane pairs inside
// `run-probes-suite` and then runs three more suites against that profile. So
// the first flow's `configureGateway` is the only one that pairs, and every
// `ensureDemo` after it lands on a gateway whose client has already cloned. The
// notes corpus was seeded (16 rows, in the log) and the phone never saw a row.
//
// What that looked like from CI: `springboardState` in
// `apps/mobile/src/screens/home/springboard-policy.ts` sees every tile settled
// and empty, calls it `first-run`, and Home renders `DayOne` INSTEAD of
// `LauncherGrid`. So `Open Notes.*` did not exist — while `HOME_READY_MARKER`
// ("All apps and places", a HomeBand label) rendered in both states and reported
// the screen ready. Twelve journeys failed at their first tap with
// `Element not found`, on an app that was behaving correctly.
//
// So the corpus is seeded by the LANE, once, before Maestro runs at all — see
// `seed-demo-corpus.mjs` and the two `android-emulator-*.sh` scripts. The
// per-flow `ensureDemo` calls stay: they document what a flow depends on, they
// are the fixture when a flow is run on its own, and the GET guard below makes
// them no-ops once the lane has seeded.

/** Bearer header for the tokenless CI gateway, which sends an empty token. */
function authHeaders(gatewayToken) {
  return gatewayToken ? { authorization: `Bearer ${gatewayToken}` } : {};
}

/** `GET /centraid/_vault/demo` — every app, its row count, and whether it
 *  ships a `seed.js` scenario at all. */
export async function demoStatus(gatewayUrl, gatewayToken = "") {
  const base = gatewayUrl.replace(/\/+$/u, "");
  const response = await fetch(`${base}/centraid/_vault/demo`, {
    headers: authHeaders(gatewayToken),
  });
  const status = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(status?.apps))
    throw new Error(
      `gateway refused demo status (${status?.error ?? response.status})`
    );
  return status.apps;
}

/**
 * Seed one scenario, idempotently. Returns what happened so the caller can say
 * it: `{ appId, rows, seeded }` with `seeded: false` when the corpus was
 * already there.
 *
 * The row-count guard is what makes a second call free, and it is why the lane
 * seeding above and a flow's own `ensureDemo` can both run without the flow
 * paying for a re-seed it does not need.
 */
export async function seedDemo(appId, gatewayUrl, gatewayToken = "") {
  if (!gatewayUrl)
    throw new Error("a gateway URL is required to seed demo data");
  const base = gatewayUrl.replace(/\/+$/u, "");
  const apps = await demoStatus(base, gatewayToken);
  const current = apps.find((app) => app?.appId === appId);
  if (!current?.seedable)
    throw new Error(`gateway does not ship the ${appId} demo scenario`);
  if (Number(current.rows) > 0)
    return { appId, rows: Number(current.rows), seeded: false };

  const response = await fetch(
    `${base}/centraid/_vault/demo/${encodeURIComponent(appId)}`,
    { headers: authHeaders(gatewayToken), method: "POST" }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `gateway refused ${appId} demo seed (${result?.error ?? response.status})`
    );
  return { appId, rows: result.rows ?? 0, seeded: true };
}

/** Purge one scenario. Used by the empty-vault journeys, which must run BEFORE
 *  their own pairing for the same reason seeding must. */
export async function purgeDemo(appId, gatewayUrl, gatewayToken = "") {
  if (!gatewayUrl)
    throw new Error("a gateway URL is required to purge demo data");
  const base = gatewayUrl.replace(/\/+$/u, "");
  const response = await fetch(
    `${base}/centraid/_vault/demo/${encodeURIComponent(appId)}`,
    { headers: authHeaders(gatewayToken), method: "DELETE" }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `gateway refused ${appId} demo purge (${result?.error ?? response.status})`
    );
  return { appId, purged: result.purged ?? 0 };
}

/**
 * Every app a launcher tile can be tapped for.
 *
 * `locker` is deliberately absent and deliberately tappable: its tile body is a
 * STATE rather than a query result, so `tileEarnsGrid` promotes it on an empty
 * vault and it ships no `seed.js`. Every OTHER cover a flow opens from Home
 * needs its app to have earned the grid, which means rows.
 */
export const ALWAYS_EARNS_GRID = ["locker"];
