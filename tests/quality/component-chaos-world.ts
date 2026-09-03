import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import path from "node:path";

import { handleReplicaIntent } from "../../packages/server/src/routes/replica-intent-route.js";
import { openVaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import type { VaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import { tempDir } from "../../packages/test-kit/src/temp-dir.js";
import {
  approvePlanner,
  openPlannerBackend,
  PLANNER_APP_ID,
} from "./chaos-planner-app.js";
import type { BackendMode } from "./chaos-planner-app.js";
import { openDurableOutbox } from "./chaos-replica-store.js";
import type { DurableOutbox } from "./chaos-replica-store.js";

const DEVICE_HEADER = "x-centraid-chaos-device";
const DEVICE_ID = "chaos-composition-device";
const INTENT_PATH = "/centraid/_vault/replica/intents";

export type { BackendMode } from "./chaos-planner-app.js";

export interface ComponentChaosWorld {
  plane: () => VaultPlane;
  restartGateway: () => void;
  setBackend: (mode: BackendMode) => void;
  openOutbox: () => DurableOutbox;
  submit: (intent: unknown) => Promise<{
    status: number;
    outcome: { intentId: string; status: string } | undefined;
  }>;
  taskTitles: () => string[];
  executedOutcomeCount: () => number;
  close: () => Promise<void>;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export async function openComponentChaosWorld(): Promise<ComponentChaosWorld> {
  const root = await tempDir("chaos-composition-");
  const vaultDir = path.join(root, "vault");
  const outboxFile = path.join(root, "outbox.sqlite");

  const openPlane = (): VaultPlane =>
    openVaultPlane({
      bootstrap: true,
      dir: vaultDir,
      logger: silentLogger,
      enableWalShipper: false,
    });

  let plane = openPlane();
  approvePlanner(plane);
  const backend = await openPlannerBackend(() => plane);
  const outboxes: DurableOutbox[] = [];

  const server: Server = createServer((req, res) => {
    if (req.headers[DEVICE_HEADER] !== DEVICE_ID) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "no_forwarded_identity" }));
      return;
    }
    void handleReplicaIntent(req, res, {
      plane,
      access: {
        canWrite: true,
        rememberDevice: true,
        deviceId: DEVICE_ID,
        appId: PLANNER_APP_ID,
      },
      dispatch: backend.dispatch,
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    plane: () => plane,
    restartGateway: () => {
      plane.stop();
      plane = openPlane();
    },
    setBackend: (mode) => backend.setMode(mode),
    openOutbox: () => {
      const outbox = openDurableOutbox(outboxFile);
      outboxes.push(outbox);
      return outbox;
    },
    submit: async (intent) => {
      const response = await fetch(`${base}${INTENT_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [DEVICE_HEADER]: DEVICE_ID,
        },
        body: JSON.stringify(intent),
      });
      const parsed = (await response.json()) as {
        outcome?: { intentId: string; status: string };
      };
      return { status: response.status, outcome: parsed.outcome };
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
      for (const outbox of outboxes.splice(0)) {
        try {
          outbox.close();
        } catch {
          // Intentionally empty.
        }
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      plane.stop();
      await backend.cleanup();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
