// Readiness probe for the mobile E2E host. A list-only check can stay green
// when the device-pairing route or live Iroh endpoint is absent, which made the
// iOS lane fail only after the expensive native build. The sentinel is owned
// by the gateway process and flips only after fixture commit and Iroh startup;
// readiness must never mint a live enrollment capability.

const baseUrl = (process.argv[2] ?? "http://127.0.0.1:18789").replace(
  /\/+$/u,
  ""
);

const request = (url, options = {}) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });

const readiness = await request(`${baseUrl}/centraid/_ci/ready`);
const readinessBody = await readiness.json().catch(() => ({}));
if (
  !readiness.ok ||
  readinessBody?.ready !== true ||
  typeof readinessBody.fixtureId !== "string" ||
  readinessBody.fixtureId.length !== 64 ||
  typeof readinessBody.gatewayEndpointId !== "string" ||
  readinessBody.gatewayEndpointId.length === 0
)
  process.exit(1);

const apps = await request(`${baseUrl}/centraid/_apps`);
if (!apps.ok) process.exit(1);

console.log("mobile CI gateway ready (fixture committed + Iroh endpoint live)");
