import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  currentReplicaLogState,
  pruneReplicaChanges,
  REPLICA_COMPACTION_HELD_ENTITIES,
} from "@centraid/vault";

import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import {
  projectReplicaPage,
  replicaShapeIds,
  SHAPE_CONTROL_ENTITIES,
} from "./replica-projection.js";
import type { ReplicaProjectedPage } from "./replica-projection.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

const access = { canWrite: true, rememberDevice: true, appId: "planner" };

function doorbellFacts(page: ReplicaProjectedPage): unknown {
  return {
    doorbell: page.doorbell,
    from: page.batch.from,
    to: page.batch.to,
    hasMore: page.batch.hasMore,
    shapeIds: page.batch.shapeIds,
    shapes: replicaShapeIds(page.shapes),
    rebootstrapReason: page.rebootstrapReason,
  };
}

describe("replica projection doorbell-only mode", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function plane(): Promise<VaultPlane> {
    const dir = await tempDir(`replica-projection-${crypto.randomUUID()}-`);
    const opened = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => opened.stop()
    );
    return opened;
  }

  async function mixedPage(): Promise<{
    vault: VaultPlane;
    since: ReturnType<typeof currentReplicaLogState>["watermark"];
  }> {
    const vault = await plane();
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [
        {
          schema: "schedule",
          table: "task",
          verbs: "read",
          rowFilter: [{ column: "status", op: "eq", value: "needs-action" }],
          fieldMask: ["title", "description"],
        },
      ],
    });
    const insert = vault.db.vault.prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, description, status, priority)
       VALUES (?, ?, ?, ?, ?, 0)`
    );
    insert.run(
      "task-visible",
      vault.boot.ownerPartyId,
      "Visible",
      "short",
      "needs-action"
    );
    insert.run(
      "task-leaving",
      vault.boot.ownerPartyId,
      "Leaving",
      "short",
      "needs-action"
    );
    const since = currentReplicaLogState(vault.db.vault).watermark;

    vault.db.vault
      .prepare(
        `UPDATE schedule_task SET title = ?, description = ? WHERE task_id = ?`
      )
      .run("Updated", "x".repeat(70_000), "task-visible");
    vault.db.vault
      .prepare(
        `UPDATE schedule_task SET status = 'completed' WHERE task_id = ?`
      )
      .run("task-leaving");
    insert.run(
      "task-unseen",
      vault.boot.ownerPartyId,
      "Never visible",
      "short",
      "completed"
    );
    return { vault, since };
  }

  test("skipping the shaped values changes nothing a doorbell caller reads", async () => {
    const { vault, since } = await mixedPage();

    const full = projectReplicaPage(vault.db.vault, access, since);
    const doorbellOnly = projectReplicaPage(
      vault.db.vault,
      access,
      since,
      1_000,
      {
        doorbellOnly: true,
      }
    );

    expect(doorbellFacts(doorbellOnly)).toStrictEqual(doorbellFacts(full));
    expect(doorbellOnly.doorbell.length).toBeGreaterThan(0);
    expect(doorbellOnly.batch.changes).toStrictEqual([]);
    expect(JSON.stringify(doorbellOnly)).not.toContain("Updated");
    expect(full.batch.changes).toStrictEqual([
      expect.objectContaining({
        op: "upsert",
        values: expect.objectContaining({ title: "Updated" }),
        oversizedFields: ["description"],
      }),
      expect.objectContaining({ op: "delete" }),
    ]);
  });

  test("a partial page reports the same cursor and hasMore in both modes", async () => {
    const { vault, since } = await mixedPage();

    const full = projectReplicaPage(vault.db.vault, access, since, 1);
    const doorbellOnly = projectReplicaPage(vault.db.vault, access, since, 1, {
      doorbellOnly: true,
    });

    expect(full.batch.hasMore).toBe(true);
    expect(doorbellFacts(doorbellOnly)).toStrictEqual(doorbellFacts(full));
    expect(doorbellOnly.batch.to).not.toStrictEqual(since);
  });

  test("a consent change still rebootstraps identically in both modes", async () => {
    const { vault, since } = await mixedPage();
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", table: "event", verbs: "read" }],
    });

    const full = projectReplicaPage(vault.db.vault, access, since);
    const doorbellOnly = projectReplicaPage(
      vault.db.vault,
      access,
      since,
      1_000,
      {
        doorbellOnly: true,
      }
    );

    expect(full.rebootstrapReason).toBe("shape-changed");
    expect(doorbellFacts(doorbellOnly)).toStrictEqual(doorbellFacts(full));
    expect(doorbellOnly.doorbell).toStrictEqual([]);
  });
});

describe("replica projection under retention compaction", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  const CHURN = 20;

  async function churnedVault(): Promise<{
    vault: VaultPlane;
    since: ReturnType<typeof currentReplicaLogState>["watermark"];
    base: ReplicaState;
  }> {
    const dir = await tempDir(`replica-compaction-${crypto.randomUUID()}-`);
    const vault = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => vault.stop()
    );
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [
        {
          schema: "schedule",
          table: "task",
          verbs: "read",
          rowFilter: [{ column: "status", op: "eq", value: "needs-action" }],
          fieldMask: ["title", "description"],
        },
      ],
    });
    const granted = currentReplicaLogState(vault.db.vault).watermark;
    const insert = vault.db.vault.prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, description, status, priority)
       VALUES (?, ?, ?, ?, 'needs-action', 0)`
    );
    for (const id of ["hot-a", "hot-b", "leaver", "doomed"])
      insert.run(id, vault.boot.ownerPartyId, id, "seed");
    const since = currentReplicaLogState(vault.db.vault).watermark;
    const base = replay(vault, granted);

    const retitle = vault.db.vault.prepare(
      `UPDATE schedule_task SET title = ? WHERE task_id = ?`
    );
    const restatus = vault.db.vault.prepare(
      `UPDATE schedule_task SET status = ? WHERE task_id = ?`
    );
    for (let index = 0; index < CHURN; index += 1) {
      retitle.run(`hot-a ${index}`, "hot-a");
      retitle.run(`hot-b ${index}`, "hot-b");
    }
    restatus.run("completed", "leaver");
    retitle.run("leaver later", "leaver");
    retitle.run("hot-a last", "hot-a");
    vault.db.vault
      .prepare(`DELETE FROM schedule_task WHERE task_id = 'doomed'`)
      .run();
    return { vault, since, base };
  }

  type ReplicaState = Map<string, { values: unknown; version: number }>;

  function replay(
    vault: VaultPlane,
    since: ReturnType<typeof currentReplicaLogState>["watermark"],
    base: ReplicaState = new Map()
  ): ReplicaState {
    const rows: ReplicaState = new Map(base);
    let cursor = since;
    for (let page = 0; page < 200; page += 1) {
      const projected = projectReplicaPage(vault.db.vault, access, cursor, 3);
      expect(projected.rebootstrapReason).toBeUndefined();
      for (const change of projected.batch.changes) {
        const key = `${change.shapeId}/${change.entity}/${change.rowId}`;
        const version =
          change.op === "delete" ? change.rowVersion : (change.rowVersion ?? 0);
        const held = rows.get(key);
        if (held && held.version > version) continue;
        if (change.op === "delete") rows.delete(key);
        else rows.set(key, { values: change.values, version });
      }
      if (!projected.batch.hasMore) break;
      cursor = projected.batch.to;
    }
    return rows;
  }

  function snapshot(rows: ReplicaState): string {
    return JSON.stringify(
      [...rows.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, row]) => [key, row.values])
    );
  }

  function compact(vault: VaultPlane, since: { seq: number }): void {
    const entries = (
      vault.db.vault
        .prepare(`SELECT COUNT(*) AS n FROM replica_change`)
        .get() as { n: number }
    ).n;
    const result = pruneReplicaChanges(vault.db.vault, {
      maxEntries: entries - 1,
    });
    expect(result.compacted).toBeGreaterThan(CHURN);
    expect(result.overflow).toBe(0);
    expect(result.floor.seq).toBeLessThanOrEqual(since.seq);
  }

  test("a catch-up replay lands byte-identical with and without compaction", async () => {
    const { vault, since, base } = await churnedVault();
    const expected = snapshot(replay(vault, since, base));

    compact(vault, since);

    expect(snapshot(replay(vault, since, base))).toStrictEqual(expected);
    expect(expected).toContain("hot-a last");
    expect(expected).not.toContain("leaver");
    expect(expected).not.toContain("doomed");
  });

  test("rowVersion is unchanged by compaction, because a row's last entry never folds", async () => {
    const { vault, since } = await churnedVault();
    const versions = (): unknown[] =>
      projectReplicaPage(vault.db.vault, access, since, 1_000)
        .batch.changes.map((change) => change.rowVersion)
        .sort((left, right) => Number(left) - Number(right));
    const expected = versions();

    compact(vault, since);

    expect(versions()).toStrictEqual(expected);
  });

  test("SABOTAGE: stripping the folded prior loses the filter-exit delete", async () => {
    const { vault, since, base } = await churnedVault();
    const expected = snapshot(replay(vault, since, base));
    compact(vault, since);
    vault.db.vault.exec(
      `UPDATE replica_change SET prior_op = NULL, prior_old_values_json = NULL`
    );

    const sabotaged = snapshot(replay(vault, since, base));

    expect(sabotaged).not.toStrictEqual(expected);
    expect(sabotaged).toContain("leaver");
  });

  test("SABOTAGE: dropping a row's last entry strands a deleted row", async () => {
    const { vault, since, base } = await churnedVault();
    const expected = snapshot(replay(vault, since, base));
    compact(vault, since);
    vault.db.vault.exec(
      `DELETE FROM replica_change WHERE op = 'delete' AND row_id = 'doomed'`
    );

    const sabotaged = snapshot(replay(vault, since, base));

    expect(sabotaged).not.toStrictEqual(expected);
    expect(sabotaged).toContain("doomed");
  });

  test("every shape-control entity is held out of compaction", () => {
    expect(
      [...SHAPE_CONTROL_ENTITIES].filter(
        (entity) => !REPLICA_COMPACTION_HELD_ENTITIES.includes(entity)
      )
    ).toStrictEqual([]);
  });
});
