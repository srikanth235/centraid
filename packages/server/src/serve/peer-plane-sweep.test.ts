import { describe, expect, it, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "./gateway-db.js";
import { createPeerPlaneSweep } from "./peer-plane-sweep.js";
import { enqueueShareEffect } from "./share-effects.js";
import { VaultLinksStore } from "./vault-links-store.js";

function seedEdge(db: GatewayDatabase, edgeId: string): void {
  const now = new Date().toISOString();
  db.run(
    "INSERT OR IGNORE INTO owners (owner_id, label, created_at) VALUES ('own-1', 'Owner', ?)",
    Date.now()
  );
  db.run(
    `INSERT OR IGNORE INTO devices
       (enrollment_id, endpoint_id, owner_id, label, remember_device, added_at)
     VALUES ('enr-1', 'dev-1', 'own-1', 'Laptop', 1, ?)`,
    now
  );
  db.run(
    `INSERT INTO share_edges
       (edge_id, created_by_device, owner_id, kind, mode, item_type,
        scope_json, origin_vault_id, audience_vault_id, verbs,
        target_state, source_state, status, created_at, updated_at)
     VALUES (?, 'dev-1', 'own-1', 'add', 'snapshot', 'media.asset',
             '["item-1"]', 'vlt_local', 'vlt_other', 'read',
             'queued', 'not-needed', 'in-flight', ?, ?)`,
    edgeId,
    now,
    now
  );
}

function queuedIds(db: GatewayDatabase): string[] {
  return (
    db.db
      .prepare("SELECT effect_id FROM share_effects WHERE status = 'queued'")
      .all() as unknown as { effect_id: string }[]
  ).map((row) => row.effect_id);
}

describe("peer plane sweep (#726 P3 gap 2)", () => {
  it("idles without touching the outbox when there is nothing to drain", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-idle-"));
    const links = VaultLinksStore.open(db);
    const sweep = createPeerPlaneSweep({
      db,
      links,
      vaultFor: () => undefined,
      partyIdFor: () => "edge-party",
      dial: () => undefined,
    });
    await sweep.runOnce();
    expect(db.db.prepare("SELECT * FROM share_effects").all()).toHaveLength(0);
  });

  it("runs the route re-announcement on every tick, even with no dial (#750 invariant 3)", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-announce-"));
    const links = VaultLinksStore.open(db);
    let announced = 0;
    const sweep = createPeerPlaneSweep({
      db,
      links,
      vaultFor: () => undefined,
      partyIdFor: () => "edge-party",
      dial: () => undefined,
      announceRoutes: async () => {
        announced += 1;
      },
    });
    await sweep.runOnce();
    expect(announced).toBe(1);
  });

  it("drains a durable obligation on a SCHEDULER TICK, not a direct call", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-tick-"));
    const links = VaultLinksStore.open(db);
    enqueueShareEffect(db, { kind: "deliver-give", edgeId: "edge-tick" });
    const sweep = createPeerPlaneSweep({
      db,
      links,
      vaultFor: () => undefined,
      partyIdFor: () => "edge-party",
      dial: () => undefined,
      idleIntervalMs: 10,
      activeIntervalMs: 10,
    });
    try {
      sweep.start();
      await vi.waitFor(
        () => {
          expect(queuedIds(db)).toStrictEqual([]);
        },
        { timeout: 2000, interval: 10 }
      );
    } finally {
      sweep.stop();
    }
  });

  it("backs off after a failure instead of spinning, and recovers", async () => {
    const db = GatewayDatabase.open(tempDirSync("centraid-sweep-backoff-"));
    const links = VaultLinksStore.open(db);
    let calls = 0;
    const warnings: string[] = [];
    seedEdge(db, "edge-backoff");
    enqueueShareEffect(db, { kind: "deliver-give", edgeId: "edge-backoff" });
    const sweep = createPeerPlaneSweep({
      db,
      links,
      partyIdFor: () => "edge-party",
      vaultFor: () => {
        calls += 1;
        throw new Error("simulated db failure");
      },
      dial: () => undefined,
      idleIntervalMs: 10,
      logger: { warn: (message) => warnings.push(message) },
    });
    await sweep.runOnce();
    expect(calls).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/simulated db failure/u);
    expect(queuedIds(db)).toStrictEqual(["give:edge-backoff"]);
  });
});
