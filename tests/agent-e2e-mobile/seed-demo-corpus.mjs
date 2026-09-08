// Seed the demo corpus for a whole LANE, before any flow pairs (#905).
//
// Run by `android-emulator-install.sh` — so both the PR gate and the roster get
// it — after the gateway is up and before Maestro is invoked. That placement IS
// the fix: see `lib/demo-corpus.mjs` for why seeding after the first pairing is
// invisible rather than merely late.
//
// It seeds EVERY app that ships a `seed.js`, not a per-lane subset, for a
// reason the per-flow calls cannot express: a launcher tile exists only when its
// app earned the grid, and a flow that names one scenario can still tap a tile
// another app owns — the home-apps and Photos suites walk every cover between
// them. A lane-wide corpus makes "which apps does this lane's grid show" a
// property of the lane rather than of whichever flow happened to run first.
//
// FAILS THE LANE. A missing corpus does not produce a missing corpus's error —
// it produces twelve journeys failing at their first tap with `Element not
// found`, which is a day of reading logs to reach a fact this script knows in
// one line.

import { demoStatus, seedDemo } from "./lib/demo-corpus.mjs";

const gatewayUrl = process.env.MAESTRO_GATEWAY_URL;
const gatewayToken = process.env.MAESTRO_GATEWAY_TOKEN ?? "";

if (!gatewayUrl) {
  console.error(
    "::error::seed-demo-corpus: MAESTRO_GATEWAY_URL is unset, so no corpus could be seeded. " +
      "Every launcher-tile tap in this lane would fail with `Element not found` on a correct app."
  );
  process.exit(1);
}

const apps = await demoStatus(gatewayUrl, gatewayToken);
const seedable = apps.filter((app) => app?.seedable).map((app) => app.appId);

if (seedable.length === 0) {
  console.error(
    "::error::seed-demo-corpus: the gateway ships no seedable scenarios. " +
      "packages/blueprints/apps/*/seed.js is what it reads; an empty set means the bundled apps did not reach it."
  );
  process.exit(1);
}

// RECURSIVE, not a `for` loop with an `await` inside it — the same shape and
// the same reason as `lib/run-suite.mjs`'s member loop. These are writes into
// ONE vault through ONE gateway process, so they are strictly sequential and
// `Promise.all` would be wrong rather than faster; the recursion says that in a
// shape the linter reads as intentional instead of as an oversight to suppress.
const ordered = seedable.sort();
async function seedFrom(index) {
  const appId = ordered[index];
  if (!appId) return;
  const result = await seedDemo(appId, gatewayUrl, gatewayToken);
  console.log(
    result.seeded
      ? `seed-demo-corpus: ${appId} seeded (${result.rows} rows)`
      : `seed-demo-corpus: ${appId} already present (${result.rows} rows)`
  );
  return seedFrom(index + 1);
}
await seedFrom(0);

console.log(
  `seed-demo-corpus: ${seedable.length} scenario(s) ready before first pairing`
);
