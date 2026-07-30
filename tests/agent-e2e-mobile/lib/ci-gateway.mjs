// Tokenless, loopback-only HTTP host plus a real Iroh device plane for the
// nightly mobile journeys. It mounts the production gateway composition
// directly so the phone must redeem a one-time pairing ticket before it can
// exercise clone/publish/list/static-serve. The HTTP listener remains
// loopback-only; remote app traffic crosses the proved Iroh transport.

import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { makeDaemonDevicePlane } from "../../../packages/gateway/dist/cli/endpoint-host.js";
import { daemonLayoutFor } from "../../../packages/gateway/dist/cli/paths.js";
import { buildGateway } from "../../../packages/gateway/dist/serve/build-gateway.js";
import { GatewayDatabase } from "../../../packages/gateway/dist/serve/gateway-db.js";
import { kitlessHostIdentity } from "../../../packages/gateway/dist/serve/host-identity.js";
import { KeyStore } from "../../../packages/vault/dist/index.js";

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

const gateway = await buildGateway({
  paths: layout,
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

const server = http.createServer((request, response) => {
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
