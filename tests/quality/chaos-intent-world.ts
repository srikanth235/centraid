import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";

import type { SeededRandom } from "@centraid/test-kit/random";

import { SqliteIntentStore } from "../../apps/mobile/src/lib/replica/sqlite-intent-store.js";
import { IntentQueue } from "../../packages/client/src/replica/intents.js";
import { NodeSqliteDriver } from "../../packages/client/src/replica/node-sqlite-test-driver.js";
import { handleReplicaIntent } from "../../packages/server/src/routes/replica-intent-route.js";
import { openVaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import type { VaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import { tempDir } from "../../packages/test-kit/src/temp-dir.js";
import {
  createTunnelClient,
  inspectEndpointTicket,
  startGatewayEndpoint,
} from "../../packages/tunnel/src/index.js";
import type {
  GatewayEndpointHandle,
  TunnelClient,
} from "../../packages/tunnel/src/index.js";
import { chaosConnection } from "./chaos-link.js";
import type { ChaosFaultSetting, ChaosMeter } from "./chaos-link.js";
import {
  approvePlanner,
  openPlannerBackend,
  PLANNER_APP_ID,
} from "./chaos-planner-app.js";

const LOOPBACK_TOKEN = "network-chaos-loopback-secret";
const DEVICE_HEADER = "x-centraid-chaos-device";
export const INTENT_PATH = "/centraid/_vault/replica/intents";

function endpointSecret(role: string, label: string): Uint8Array {
  return new Uint8Array(
    createHash("sha256").update(`centraid.chaos.${role}.${label}`).digest()
  );
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ChaosDial {
  readonly connection: import("../../packages/tunnel/src/iroh.js").Connection;
  readonly meter: ChaosMeter;
  close: () => void;
}

export interface ChaosIntentWorld {
  readonly plane: VaultPlane;
  deviceEndpointId: () => string;
  gatewayEndpointId: () => string;
  dial: (fault: ChaosFaultSetting, rng: SeededRandom) => Promise<ChaosDial>;
  restartGatewayEndpoint: () => Promise<void>;
  rebindClient: () => Promise<void>;
  taskTitles: () => string[];
  executedOutcomeCount: () => number;
  close: () => Promise<void>;
}

export function chaosIntentQueue(): IntentQueue {
  return new IntentQueue(SqliteIntentStore.create(new NodeSqliteDriver()));
}

export async function openChaosIntentWorld(
  label: string
): Promise<ChaosIntentWorld> {
  const gatewaySecret = endpointSecret("gateway", label);
  const deviceSecret = endpointSecret("device", label);
  const vaultDir = await tempDir("chaos-net-vault-");

  const plane = openVaultPlane({
    bootstrap: true,
    dir: vaultDir,
    logger: silentLogger,
    enableWalShipper: false,
  });
  approvePlanner(plane);
  const backend = await openPlannerBackend(() => plane);

  const server: Server = createServer((req, res) => {
    const deviceId = req.headers[DEVICE_HEADER];
    if (typeof deviceId !== "string") {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "no_forwarded_identity" }));
      return;
    }
    void handleReplicaIntent(req, res, {
      plane,
      access: {
        canWrite: true,
        rememberDevice: true,
        deviceId,
        appId: PLANNER_APP_ID,
      },
      dispatch: backend.dispatch,
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const bindEndpoint = (): Promise<GatewayEndpointHandle> =>
    startGatewayEndpoint({
      secretKey: gatewaySecret,
      upstream: () => ({ baseUrl, token: LOOPBACK_TOKEN }),
      authorize: (endpointId) => endpointId === deviceId,
      pair: () => ({ ok: false, error: "not_used" }),
      requestHeaders: (endpointId) => ({ [DEVICE_HEADER]: endpointId }),
      relays: "disabled",
    });

  let client: TunnelClient = await createTunnelClient({
    secretKey: deviceSecret,
    relays: "disabled",
  });
  const deviceId = client.endpointId;
  let endpoint = await bindEndpoint();
  const live: Array<{ close: () => void }> = [];

  return {
    plane,
    deviceEndpointId: () => client.endpointId,
    gatewayEndpointId: () =>
      inspectEndpointTicket(endpoint.ticket()).endpointId,
    dial: async (fault, rng) => {
      const raw = await client.connect(endpoint.ticket());
      const dropped = { done: false };
      const { connection, meter } = chaosConnection(raw, {
        fault,
        rng,
        onDrop: () => {
          dropped.done = true;
          raw.close(0n, []);
        },
      });
      const dial: ChaosDial = {
        connection,
        meter,
        close: () => {
          if (!dropped.done) raw.close(0n, []);
        },
      };
      live.push(dial);
      return dial;
    },
    restartGatewayEndpoint: async () => {
      await endpoint.close();
      endpoint = await bindEndpoint();
    },
    rebindClient: async () => {
      await client.close();
      client = await createTunnelClient({
        secretKey: deviceSecret,
        relays: "disabled",
      });
    },
    taskTitles: () =>
      (
        plane.db.vault
          .prepare("SELECT title FROM schedule_task ORDER BY title")
          .all() as Array<{ title: string }>
      ).map((row) => row.title),
    executedOutcomeCount: () =>
      (
        plane.db.vault
          .prepare(
            "SELECT count(*) AS n FROM replica_intent_outcome WHERE status = 'executed'"
          )
          .get() as { n: number }
      ).n,
    close: async () => {
      for (const dial of live.splice(0)) dial.close();
      await client.close().catch(() => undefined);
      await endpoint.close().catch(() => undefined);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      plane.stop();
      await backend.cleanup();
      await fs.rm(vaultDir, { recursive: true, force: true });
    },
  };
}
