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
