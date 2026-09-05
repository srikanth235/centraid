import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  goldenYear3Profile,
  seedYear3Vault,
} from "@centraid/test-kit/year3-vault";

import { EnrollmentStore } from "../../../../packages/server/dist/serve/enrollment-store.js";
import { GatewayDatabase } from "../../../../packages/server/dist/serve/gateway-db.js";
import { PairingTicketStore } from "../../../../packages/server/dist/serve/pairing-store.js";
import { serve } from "../../../../packages/server/dist/serve/serve.js";
import {
  WebControlSessionStore,
  hashControlToken,
} from "../../../../packages/server/dist/serve/web-session-store.js";
import { sealAad, sealValue } from "../../../../packages/vault/dist/index.js";

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

// A VOLUME, so the perf specs are not measuring an empty vault (#927). Every
// journey ceiling this harness produces is stated at the volume declared in
// `tests/journeys.json` as `year3`.
//
// TWO seeds, and the split is the point. The shared year-3 generator supplies
// the row COUNT that makes a cold-open number an O(vault-size) gate rather than
// a bundle ratchet — the same statements, the same declared distribution and
// the same fixture version every other rig measures against. Each bundled app's
// own demo route then runs through the gateway's WRITE PATH, because those rows
// are what the functional specs address by name and a direct insert skips the
// journal sequence the replica cursor is derived from.
//
// The generator goes FIRST, and the order is load-bearing: it plants the flags
// concept scheme by URI, and the product's own flag writer (`flags.ts`) creates
// that scheme on first use, so a demo seed run afterwards adopts the existing
// row while the reverse collides on `core_concept_scheme.uri`.
const plane = handle.vaults.get(handle.vaults.defaultVaultId());
if (!plane) throw new Error("the auto-founded Personal vault is not mounted");
seedYear3Vault(
  {
    vault: plane.db.vault,
    sealCell: (entity, column, rowId, plaintext) =>
      sealValue(
        plane.db.sealKey,
        sealAad(entity.replace(".", "_"), column, rowId),
        plaintext
      ),
  },
  goldenYear3Profile()
);

const seedHeaders = {
  Authorization: "Bearer centraid-web-e2e-token",
  "content-type": "application/json",
};
const listed = (await (
  await fetch(`${handle.url}/centraid/_vault/demo`, { headers: seedHeaders })
).json()) as { apps: { appId: string; seedable: boolean }[] };
for (const app of listed.apps.filter((entry) => entry.seedable)) {
  // oxlint-disable-next-line no-await-in-loop -- (#927) the gateway's write path is serial; firing eight seeds at once would measure its admission queue, not seed a vault
  await fetch(`${handle.url}/centraid/_vault/demo/${app.appId}`, {
    method: "POST",
    headers: seedHeaders,
    body: "{}",
  });
}

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
