import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { diffCounters } from "@centraid/core/protocol";
import {
  atlasCensus,
  atlasGraph,
  atlasPulse,
  createGateway,
  gatewayWorkCounters,
  instrumentVaultStatements,
  sealAad,
  sealValue,
} from "@centraid/vault";

import { ConversationHistoryStore } from "../../packages/server/src/engine/conversation/history.js";
import type { WorkspaceProvider } from "../../packages/server/src/engine/stores/vault-workspace.js";
import { openVaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import { tempDir } from "../../packages/test-kit/src/temp-dir.js";
import { seedYear3Vault } from "../../packages/test-kit/src/year3-vault.js";
import { createTestVault } from "../helpers/factories.js";
import { journeyCeiling } from "../helpers/journeys.js";

const FIRST_PAINT_KEY = "client/first-paint-work/year3/any";
type Screen = "photos-grid" | "notifications" | "atlas" | "assistant";

/**
 * The statements a screen's first paint costs, taken from THE PRODUCT'S OWN
 * counter (#927) rather than a second count of the same thing. This file used
 * to monkey-patch `DatabaseSync.prepare` and count the SELECTs it saw, which
 * measured a different quantity from the one the merge-rung gate compares —
 * two instruments over one fact, free to disagree. `gatewayWorkCounters` is the
 * instrument every other counter gate reads: statement EXECUTIONS on the handle
 * the gateway instruments, monotonic for the life of the process, so a snapshot
 * pair is the cost of exactly what happened between them.
 */
function countStatements(db: DatabaseSync): () => number {
  // Instrument the handle THIS screen reads. `createGateway` does it for the
  // gateway's own connection; a screen that reads a vault plane or calls a
  // vault function directly gets it here, so no screen is counted as costing
  // zero statements because nobody wrapped its handle.
  instrumentVaultStatements(db);
  const before = gatewayWorkCounters();
  return () => diffCounters(before, gatewayWorkCounters()).statements;
}

async function screenHttpHarness(
  routes: Readonly<Record<string, () => unknown | Promise<unknown>>>
): Promise<{
  request: (route: string) => Promise<unknown>;
  value: () => number;
  close: () => Promise<void>;
}> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    const route = routes[req.url ?? ""];
    if (!route) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void Promise.resolve(route()).then(
      (value) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value ?? null));
      },
      (error) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
      }
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    request: async (route) => {
      const response = await fetch(`${base}${route}`);
      expect(response.status, route).toBe(200);
      return response.json();
    },
    value: () => count,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function seedSmallYear3(db: { vault: DatabaseSync; sealKey: Buffer }): void {
  seedYear3Vault(
    {
      vault: db.vault,
      sealCell: (entity, column, rowId, plaintext) =>
        sealValue(
          db.sealKey,
          sealAad(entity.replace(".", "_"), column, rowId),
          plaintext
        ),
    },
    { parties: 7, photos: 31, conversations: 3, turnsPerConversation: 4 }
  );
}

function assertBudget(
  screen: Screen,
  actual: { sqlStatements: number; httpRequests: number }
): void {
  expect(actual.sqlStatements, `${screen} SQL statements`).toBeLessThanOrEqual(
    journeyCeiling(FIRST_PAINT_KEY, screen, "maxStatements")
  );
  expect(actual.httpRequests, `${screen} HTTP requests`).toBeLessThanOrEqual(
    journeyCeiling(FIRST_PAINT_KEY, screen, "maxHttpRequests")
  );
  console.error(
    `OBSERVED ${screen} ${actual.sqlStatements} ${actual.httpRequests}`
  );
}

describe("P2 first-paint query counts on the year-3 fixture", () => {
  test("photos grid runs the real bounded library projection within budget", async () => {
    const db = await createTestVault();
    seedSmallYear3(db);
    const device = db.vault
      .prepare("SELECT device_id, public_key FROM access_device LIMIT 1")
      .get() as { device_id: string; public_key: string };
    const gateway = createGateway(db);
    const statements = countStatements(db.vault);
    const moduleUrl = pathToFileURL(
      path.resolve("packages/blueprints/apps/photos/queries/library.ts")
    ).href;
    const libraryHandler = (await import(moduleUrl)).default as (
      input: unknown
    ) => Promise<unknown>;
    const requests = await screenHttpHarness({
      "/centraid/photos/_query/library?limit=20": () =>
        libraryHandler({
          input: { limit: 20 },
          ctx: {
            vault: {
              read: async (request: Parameters<typeof gateway.read>[1]) =>
                gateway.read(
                  {
                    kind: "device",
                    deviceId: device.device_id,
                    deviceKey: device.public_key,
                  },
                  request
                ),
            },
          },
        } as never),
    });
    try {
      const projection = await requests.request(
        "/centraid/photos/_query/library?limit=20"
      );
      expect(projection).toBeTruthy();
      assertBudget("photos-grid", {
        sqlStatements: statements(),
        httpRequests: requests.value(),
      });
    } finally {
      await requests.close();
    }
  });

  test("Notifications runs its actual first-paint fetch triple within budget", async () => {
    const dir = await tempDir("quality-query-notifications-");
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      ownerName: "Query owner",
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      enableWalShipper: false,
    });
    try {
      seedSmallYear3(plane.db);
      const statements = countStatements(plane.db.vault);
      const requests = await screenHttpHarness({
        "/centraid/_vault/notifications": () =>
          plane.notificationsSummary(true),
        "/centraid/_vault/outbox/grants": () => plane.listOutboxGrants(),
        "/centraid/_vault/review-feed?limit=20": () => plane.reviewFeed(20),
      });
      try {
        const firstPaint = await Promise.all([
          requests.request("/centraid/_vault/notifications"),
          requests.request("/centraid/_vault/outbox/grants"),
          requests.request("/centraid/_vault/review-feed?limit=20"),
        ]);
        expect(firstPaint).toHaveLength(3);
        assertBudget("notifications", {
          sqlStatements: statements(),
          httpRequests: requests.value(),
        });
      } finally {
        await requests.close();
      }
    } finally {
      plane.stop();
    }
  });

  test("Atlas runs the exact stats/pulse first paint within budget", async () => {
    const db = await createTestVault();
    seedSmallYear3(db);
    const statements = countStatements(db.vault);
    const requests = await screenHttpHarness({
      "/centraid/_vault/atlas/stats": () => atlasCensus(db.vault),
      "/centraid/_vault/atlas/pulse": () => atlasPulse(db.vault),
    });
    try {
      await requests.request("/centraid/_vault/atlas/stats");
      await requests.request("/centraid/_vault/atlas/pulse");
      assertBudget("atlas", {
        sqlStatements: statements(),
        httpRequests: requests.value(),
      });
      // The graph is deliberately lazy after first paint; prove its separately
      // requested payload stays bounded without charging it to first paint.
      expect(atlasGraph(db.vault).nodes.length).toBeGreaterThan(0);
    } finally {
      await requests.close();
    }
  });

  test("Assistant reconstructs a real year-3 transcript within budget", async () => {
    const db = await createTestVault();
    seedSmallYear3(db);
    const owner = db.vault
      .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
      .get() as { self_party_id: string };
    const workspace: WorkspaceProvider = () => ({
      vaultId: "quality-vault",
      ownerPartyId: owner.self_party_id,
      appsDir: `${db.dir}/apps`,
      journal: () => db.audit,
      ledgerDbFile: `${db.dir}/vault.db`,
      harnessSessionDir: `${db.dir}/harness-sessions`,
    });
    const store = new ConversationHistoryStore(workspace);
    const conversation = db.audit
      .prepare(
        "SELECT id FROM conversations WHERE app_id = '_assistant' ORDER BY id LIMIT 1"
      )
      .get() as { id: string };
    const statements = countStatements(db.vault);
    const requests = await screenHttpHarness({
      [`/centraid/_vault/assistant/conversations/${conversation.id}`]: () =>
        store.getSession("_assistant", conversation.id),
    });
    try {
      await expect(
        requests.request(
          `/centraid/_vault/assistant/conversations/${conversation.id}`
        )
      ).resolves.toBeTruthy();
      assertBudget("assistant", {
        sqlStatements: statements(),
        httpRequests: requests.value(),
      });
    } finally {
      await requests.close();
    }
  });
});
