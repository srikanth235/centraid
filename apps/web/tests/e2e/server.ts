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
// No `initVaultName`: a fresh gateway auto-founds "Personal" at
// construction (#603), and the specs address whichever vault
// `/centraid/_web/control` hands back rather than one by name.
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
      // The harness gateway is loopback-only. Model the proved local
      // transport identity for the direct one-time app-session redemption;
      // unlike shell fetches, that browser navigation has no injected header.
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

// The general PWA smoke establishes its own bearer-derived session. The
// pending-replica journey additionally uses this deterministic, enrolled
// device session because replica routes intentionally reject an admin-only
// browser cookie with no durable device identity.
controlStore.establish({
  tokenHash: hashControlToken(webControlToken),
  vaultId: handle.vaults.defaultVaultId(),
  deviceKey: webDeviceKey,
  shellOrigin: "http://127.0.0.1:4173",
});

// No code-store fixture app is seeded. There is no served-app plane (#799), so
// the only openable apps are the eight bundled system apps the gateway installs
// into every vault at mount — which is exactly what the specs drive.
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
