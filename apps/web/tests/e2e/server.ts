import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EnrollmentStore } from "../../../../packages/server/dist/serve/enrollment-store.js";
import { GatewayDatabase } from "../../../../packages/server/dist/serve/gateway-db.js";
import { PairingTicketStore } from "../../../../packages/server/dist/serve/pairing-store.js";
import { serve } from "../../../../packages/server/dist/serve/serve.js";
import {
  WebControlSessionStore,
  hashControlToken,
} from "../../../../packages/server/dist/serve/web-session-store.js";

const dataDir = await fs.mkdtemp(
  path.join(os.tmpdir(), `centraid-web-e2e-${crypto.randomUUID()}-`)
);
const gatewayDatabase = GatewayDatabase.open(dataDir, { lock: "exclusive" });
const controlStore = WebControlSessionStore.open(gatewayDatabase);
const enrollments = EnrollmentStore.open(gatewayDatabase);
const pairingTickets = PairingTicketStore.open(gatewayDatabase);
const webDeviceKey = "web-e2e-device";
const webControlToken = "web-e2e-control-session";
const handle = await serve({
  host: "127.0.0.1",
  port: 48765,
  token: "centraid-web-e2e-token",
  gatewayDatabase,
  hostDeviceEndpointId: webDeviceKey,
  devicePairing: { enrollments, tickets: pairingTickets },
  deviceAccess: {
    deviceKeyFor: (request) => {
      const header = request.headers["x-centraid-authed-device"];
      if (typeof header === "string") return header;
      if (request.headers["x-centraid-authed-plane"] === "admin") {
        return webDeviceKey;
      }
      const remoteAddress = request.socket.remoteAddress;
      return remoteAddress === "127.0.0.1" ||
        remoteAddress === "::1" ||
        remoteAddress === "::ffff:127.0.0.1"
        ? webDeviceKey
        : undefined;
    },
    vaultsFor: (deviceKey) => enrollments.vaultsFor(deviceKey),
  },
  webSessions: {
    controlStore,
    isDeviceValid: (deviceKey) => enrollments.isEnrolled(deviceKey),
  },
  paths: {
    vaultDir: path.join(dataDir, "vault"),
  },
  web: {
    rootDir: path.resolve("dist"),
    host: "127.0.0.1",
    port: 4173,
  },
});

controlStore.establish({
  tokenHash: hashControlToken(webControlToken),
  vaultId: handle.vaults.defaultVaultId(),
  deviceKey: webDeviceKey,
  shellOrigin: "http://127.0.0.1:4173",
});

await handle.syncApps();

async function close(): Promise<void> {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
await new Promise(() => {
  void undefined;
});
