// Tokenless, loopback-only HTTP host plus a real Iroh device plane for the
// nightly mobile journeys. It mounts the production gateway composition
// directly so the phone must redeem a one-time pairing ticket before it can
// exercise clone/publish/list/static-serve. The HTTP listener remains
// loopback-only; remote app traffic crosses the proved Iroh transport.

import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { makeDaemonDevicePlane } from "../../../packages/server/dist/cli/endpoint-host.js";
import { daemonLayoutFor } from "../../../packages/server/dist/cli/paths.js";
import { buildGateway } from "../../../packages/server/dist/serve/build-gateway.js";
import { GatewayDatabase } from "../../../packages/server/dist/serve/gateway-db.js";
import { kitlessHostIdentity } from "../../../packages/server/dist/serve/host-identity.js";
import { KeyStore } from "../../../packages/vault/dist/index.js";
import {
  DEFAULT_FIRST_TOKEN_DELAY_MS,
  FIRST_TOKEN_DELAY_ENV,
  resolveDelayMs,
  stubHarnessPrefs,
} from "./fixed-delay-agent.mjs";

const dataDir = path.resolve(process.argv[2] ?? "artifacts/mobile-ci-gateway");
const port = Number(process.argv[3] ?? 18_789);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`invalid mobile CI gateway port: ${process.argv[3]}`);
}

await mkdir(dataDir, { recursive: true });
const layout = daemonLayoutFor(dataDir);
const database = GatewayDatabase.open(dataDir, { lock: "exclusive" });
const keyStore = new KeyStore(layout.keysDir);
const hostEndpointId = kitlessHostIdentity(
  keyStore.loadOrCreate("endpoint-key.bin")
);
const logger = {
  info: (message) => console.log(`[mobile-ci-gateway] ${message}`),
  warn: (message) => console.warn(`[mobile-ci-gateway] ${message}`),
  error: (message) => console.error(`[mobile-ci-gateway] ${message}`),
};
const runtime = {};
const devicePlane = makeDaemonDevicePlane({
  layout,
  gatewayDatabase: database,
  vaults: () => runtime.gateway?.vaults,
  logger,
  keyStore,
  loopbackEndpointId: hostEndpointId,
});

// THE ASSISTANT'S MODEL PROVIDER (#890 follow-up). Without this the CI gateway
// has no provider at all: a turn cannot start, no token is ever produced, and
// `sendToFirstToken` in tests/journeys.json stays unmeasurable
// by construction rather than by oversight.
//
// The `acp` registry kind is the one built for exactly this — "Custom ACP
// agent", no npm adapter, no default binary, minVersion 0.0.0 — so pointing it
// at a script needs no new harness kind and no change to shipped product
// surface. `binPath` is the node binary rather than the script itself so the
// script needs no executable bit, which a git checkout on a fresh runner does
// not reliably carry.
//
// The stub answers after a KNOWN delay (fixed-delay-agent.mjs explains why a
// constant beats an instant reply), and that constant is what a latency flow
// subtracts to get the dead time this repo actually owns.
//
// The prefs come FROM the stub module rather than being spelled out here, so
// the launch-plan test in tests/integration-mobile asserts the same three values
// this gateway actually writes.
for (const [key, value] of Object.entries(stubHarnessPrefs()))
  database.setPref(key, value);

// PIN THE DELAY EXPLICITLY rather than letting the agent fall back to its own
// default. The agent inherits this process's environment (harnessSpawnEnv
// spreads it), so setting it here makes the constant a latency flow subtracts
// visible in the lane log instead of implicit in a module nobody reads while
// diagnosing a number. A lane that exports its own value overrides this; an
// empty or malformed one resolves back to the default rather than to zero.
process.env[FIRST_TOKEN_DELAY_ENV] = String(resolveDelayMs());
console.log(
  `[mobile-ci-gateway] assistant stub: first token after ${process.env[FIRST_TOKEN_DELAY_ENV]}ms` +
    ` (default ${DEFAULT_FIRST_TOKEN_DELAY_MS}ms; subtract it from any sendToFirstToken reading)`
);

const gateway = await buildGateway({
  paths: layout,
  // The nightly journeys drive automations and connectors, which ship gated
  // OFF by default (v0 early feedback) — this CI host opts both in.
  experimental: { automations: true, connectors: true },
  gatewayDatabase: database,
  deviceAccess: devicePlane.deviceAccess,
  isHostCustody: devicePlane.isHostCustody,
  keyStore,
  hostDeviceEndpointId: hostEndpointId,
  dataPlaneControl: devicePlane.dataPlaneControl,
  devicePairing: {
    ...devicePlane.pairing,
    endpointId: () => runtime.endpoint?.endpointId,
    endpointTicket: () => runtime.endpoint?.ticket(),
    onEndpointRevoked: (endpointId) =>
      runtime.endpoint?.revokeEndpoint(endpointId),
  },
});
runtime.gateway = gateway;
await gateway.start(`http://127.0.0.1:${port}`);

/*
 * WHAT THE PHONE ACTUALLY ASKED FOR (#905 O follow-up).
 *
 * A library that draws its empty state over a vault holding rows is either a
 * clone that never arrived or a read that cannot see one, and the device is
 * mute about which: nothing on the replica path logs, and the release artifact
 * carries no debugger. From here the difference is plain — a bootstrap request
 * that never appears is the first case, one that answers 200 is the second.
 *
 * The Iroh endpoint forwards into this same listener, so a paired phone's
 * requests pass through here exactly as a loopback client's do.
 *
 * Method, path and status only, and never for the enrollment surface: a pairing
 * ticket is a live capability and this log is printed into CI output. Those
 * surfaces are `/centraid/_gateway/tunnel/pair` and `/_gateway/devices/ticket`,
 * both OUTSIDE `_vault`, so the whole vault plane traces without exposing one.
 *
 * EVERY vault surface, not the four of the data path (#905). Naming only
 * replica/changes/scopes/demo answered "did it fetch rows" and nothing else:
 * the phone speaks sixteen other surfaces here — status, vaults, grants,
 * notifications — so a run where it reached the gateway and a run where the
 * tunnel never came up produced the same empty trace. They are different bugs.
 */
const TRACED = /^\/centraid\/_vault\//u;

/*
 * The SIZE is the row count's shadow, and it is the whole question: a 200 on a
 * bootstrap page proves the phone asked and the gateway answered, never that
 * the answer carried anything. An empty page and a full one differ by orders of
 * magnitude here.
 *
 * Counted rather than read off `content-length`, which the first run of this
 * trace showed is absent on every one of these responses — the header is set
 * for some routes and not others, and a diagnostic that prints `?B` for the one
 * question it exists to answer is no diagnostic. `write`/`end` are wrapped
 * because they are the only place the byte count is certain.
 */
function countBytes(response) {
  const counter = { total: 0 };
  for (const method of ["write", "end"]) {
    const original = response[method].bind(response);
    response[method] = (chunk, ...rest) => {
      if (chunk) counter.total += Buffer.byteLength(chunk);
      return original(chunk, ...rest);
    };
  }
  return counter;
}

const server = http.createServer((request, response) => {
  const startedAt = Date.now();
  const target = (request.url ?? "/").split("?")[0];
  if (TRACED.test(target)) {
    const counter = countBytes(response);
    response.on("finish", () =>
      logger.info(
        `${request.method} ${target} -> ${response.statusCode} ${counter.total}B in ${Date.now() - startedAt}ms`
      )
    );
  }
  void gateway
    .composedHandler(request, response)
    .then((handled) => {
      if (handled || response.headersSent) return;
      response.statusCode = 404;
      response.end("not found");
    })
    .catch((error) => {
      if (response.headersSent) return response.destroy(error);
      response.statusCode = 500;
      response.end("gateway error");
    });
});

await new Promise((resolve) => {
  server.listen(port, "127.0.0.1", resolve);
});
const endpoint = await devicePlane.startEndpoint({
  baseUrl: `http://127.0.0.1:${port}`,
  // The CI HTTP listener deliberately has no bearer. Iroh still proves and
  // forwards the device EndpointId; an empty upstream bearer is ignored by
  // the tokenless gateway authorizer.
  token: "",
});
if (!endpoint) {
  throw new Error("mobile CI gateway could not start its Iroh endpoint");
}
runtime.endpoint = endpoint;
console.log(`mobile CI gateway listening on http://127.0.0.1:${port}`);

async function close() {
  await new Promise((resolve) => {
    server.close(resolve);
  });
  await endpoint?.close();
  await gateway.stop();
  database.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });
}
