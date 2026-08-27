import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { currentReplicaLogState } from "@centraid/vault";

import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { projectReplicaPage, replicaShapeIds } from "./replica-projection.js";
import type { ReplicaProjectedPage } from "./replica-projection.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

const access = { canWrite: true, rememberDevice: true, appId: "planner" };

/** Everything the doorbell-only mode promises to leave untouched. */
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

  /**
   * One page that exercises every branch the two modes share: a visible
   * upsert, an oversized deferred field, a row that leaves the consent filter
   * (projected as a delete), and a row that was never visible at all.
   */
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
    // The whole point: no shaped row survives the doorbell-only walk.
    expect(doorbellOnly.batch.changes).toStrictEqual([]);
    expect(JSON.stringify(doorbellOnly)).not.toContain("Updated");
    // The full mode still ships them, upsert and projected delete alike.
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
    // A grant widened inside the page is a shape-control change: neither mode
    // may advance past it as ordinary data.
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
