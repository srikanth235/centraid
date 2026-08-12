import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { transitionEdge } from "./edges-reconcile.js";
import { listEdgesForOwner } from "./edges-routes.js";

const cleanups: Array<() => void | Promise<void>> = [];

describe(listEdgesForOwner, () => {
  afterEach(async () => {
    await Promise.all(
      cleanups
        .splice(0)
        .toReversed()
        .map((cleanup) => cleanup())
    );
  });

  test("two devices of one owner see edges created by either device", async () => {
    const dir = await tempDir("edge-owner-visibility-");
    const database = GatewayDatabase.open(dir);
    cleanups.push(async () => {
      database.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const enrollments = EnrollmentStore.open(database);
    const first = enrollments.enroll({
      endpointId: "device-a",
      label: "Laptop",
      ownerLabel: "Priya",
      vaultIds: ["vault-a"],
    });
    enrollments.enroll({
      endpointId: "device-b",
      label: "Phone",
      ownerId: first.ownerId,
      vaultIds: ["vault-a"],
    });
    const insert = database.db.prepare(
      `INSERT INTO share_edges
         (edge_id, created_by_device, owner_id, kind, mode, item_type,
          scope_json, origin_vault_id, audience_vault_id, verbs,
          target_state, source_state, status, created_at, updated_at)
       VALUES (?, ?, ?, 'add', 'snapshot', 'media.asset', '["asset-a"]',
               'vault-a', 'vault-b', 'read', 'executed', 'not-needed',
               'completed', ?, ?)`
    );
    insert.run("edge-a", "device-a", first.ownerId, "2026-01-01", "2026-01-01");
    insert.run("edge-b", "device-b", first.ownerId, "2026-01-02", "2026-01-02");

    expect(
      listEdgesForOwner(database, first.ownerId).map((edge) => edge.edge_id)
    ).toStrictEqual(["edge-b", "edge-a"]);
  });

  test("the edge reducer rejects illegal terminal shortcuts", async () => {
    const dir = await tempDir("edge-transition-model-");
    const database = GatewayDatabase.open(dir);
    cleanups.push(async () => {
      database.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const enrollment = EnrollmentStore.open(database).enroll({
      endpointId: "device-a",
      label: "Laptop",
      ownerLabel: "Priya",
      vaultIds: ["vault-a"],
    });
    database.run(
      `INSERT INTO share_edges
         (edge_id, created_by_device, owner_id, kind, mode, item_type,
          scope_json, origin_vault_id, audience_vault_id, verbs,
          target_state, source_state, status, created_at, updated_at)
       VALUES ('edge-illegal', 'device-a', ?, 'add', 'snapshot',
               'media.asset', '["asset-a"]', 'vault-a', 'vault-b', 'read',
               'queued', 'not-needed', 'queued', '2026-01-01', '2026-01-01')`,
      enrollment.ownerId
    );

    expect(() =>
      transitionEdge(database, "edge-illegal", "completed", null)
    ).toThrow(/illegal share edge transition queued -> completed/u);
    expect(listEdgesForOwner(database, enrollment.ownerId)[0]?.status).toBe(
      "queued"
    );
  });
});
