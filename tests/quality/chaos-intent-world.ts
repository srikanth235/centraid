/**
 * The rig the network-chaos lane drives (issue #842 W3.1).
 *
 * One real vault plane, the real replica-intent route, the real durable client
 * outbox, a loopback HTTP hop, a real iroh gateway endpoint, and a real tunnel
 * client — the same transport a paired phone uses. Nothing is mocked: the only
 * thing the lane adds is the chaos shim over the client connection
 * (`chaos-link.ts`) and the endpoint restarts / rebinds below.
 *
 * The workload is the replica intent plane on purpose. Intent identity is the
 * product's own no-duplicate-application law (`packages/client/src/replica/
 * intents.contract.test.ts`), so "did chaos apply this twice" is answered by
 * real vault rows rather than by a bespoke counter this file invented.
 *
 * Determinism: both endpoints are bound from FIXED secret keys, so an endpoint
 * that closes and rebinds keeps its EndpointId while its address changes —
 * which is exactly the identity-versus-address distinction the rebind faults
 * exist to test, and it is reproducible across runs.
 */

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

/** Fixed identities: a rebind must change the ADDRESS and nothing else. */
const GATEWAY_SECRET = new Uint8Array(32).fill(0xa5);
const DEVICE_SECRET = new Uint8Array(32).fill(0x5a);

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ChaosDial {
  /** The chaos-wrapped connection; every stream rides the named fault. */
  readonly connection: import("../../packages/tunnel/src/iroh.js").Connection;
  readonly meter: ChaosMeter;
  close: () => void;
}

export interface ChaosIntentWorld {
  readonly plane: VaultPlane;
  /** The device's stable transport identity — survives every rebind. */
  deviceEndpointId: () => string;
  /** The gateway's stable transport identity — survives every restart. */
  gatewayEndpointId: () => string;
  /** The gateway's CURRENT dial ticket (address data, refreshed per call). */
  ticket: () => string;
  dial: (fault: ChaosFaultSetting, rng: SeededRandom) => Promise<ChaosDial>;
  /** Close the gateway endpoint and rebind it on the same secret key. */
  restartGatewayEndpoint: () => Promise<void>;
  /** Close the client endpoint and rebind it on the same secret key. */
  rebindClient: () => Promise<void>;
  /** Titles of every task the vault actually holds, sorted. */
  taskTitles: () => string[];
  /** Executed replica outcomes recorded in the vault. */
  executedOutcomeCount: () => number;
  close: () => Promise<void>;
}

/** A durable client outbox backed by the mobile SQLite store. */
export function chaosIntentQueue(): IntentQueue {
  return new IntentQueue(SqliteIntentStore.create(new NodeSqliteDriver()));
}

export async function openChaosIntentWorld(): Promise<ChaosIntentWorld> {
  const vaultDir = await tempDir("chaos-net-vault-");

  const plane = openVaultPlane({
    bootstrap: true,
    dir: vaultDir,
    logger: silentLogger,
    enableWalShipper: false,
  });
  approvePlanner(plane);
  // The REAL app-engine dispatcher: exactly-once under a retried intent is its
  // deterministic invocation-id binding, so bypassing it would measure the
  // rig's shortcut instead of the product (see chaos-planner-app.ts).
  const backend = await openPlannerBackend(() => plane);

  const server: Server = createServer((req, res) => {
    // The forwarder stamps the QUIC-proved EndpointId. A request that reached
    // this hop without it never travelled the tunnel, and is refused rather
    // than served under an invented device identity.
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
      secretKey: GATEWAY_SECRET,
      upstream: () => ({ baseUrl, token: LOOPBACK_TOKEN }),
      // Admission is by transport identity, and the device secret is fixed —
      // so a rebound client is the SAME principal, which is the law the
      // `address-rebind` fault asserts.
      authorize: (endpointId) => endpointId === deviceId,
      pair: () => ({ ok: false, error: "not_used" }),
      requestHeaders: (endpointId) => ({ [DEVICE_HEADER]: endpointId }),
      relays: "disabled",
    });

  let client: TunnelClient = await createTunnelClient({
    secretKey: DEVICE_SECRET,
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
    ticket: () => endpoint.ticket(),
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
        secretKey: DEVICE_SECRET,
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
