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
import { capturedWrite } from "./replica-write.test-fixtures.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

const access = { canWrite: true, rememberDevice: true, appId: "planner" };

/** What doorbell-only leaves untouched. */
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
    vault.recordAppInstall("planner", {
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
    capturedWrite(vault.db.vault, () => {
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
    });
    const since = currentReplicaLogState(vault.db.vault).watermark;

    capturedWrite(vault.db.vault, () =>
      vault.db.vault
        .prepare(
          `UPDATE schedule_task SET title = ?, description = ? WHERE task_id = ?`
        )
        .run("Updated", "x".repeat(70_000), "task-visible")
    );
    capturedWrite(vault.db.vault, () =>
      vault.db.vault
        .prepare(
          `UPDATE schedule_task SET status = 'completed' WHERE task_id = ?`
        )
        .run("task-leaving")
    );
    capturedWrite(vault.db.vault, () =>
      insert.run(
        "task-unseen",
        vault.boot.ownerPartyId,
        "Never visible",
        "short",
        "completed"
      )
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

  test("an install-register change still rebootstraps identically in both modes", async () => {
    const { vault, since } = await mixedPage();
    // Shape control: neither mode may advance past it as data. Since #928 the
    // register — whether the app is installed — is what moves a shape, not a
    // grant, and revoking the install is what takes the shape away.
    vault.revokeApp("planner");

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

/**
 * A CATCH-UP REPLAY IS PAGE-SIZE INDEPENDENT (#883 C6; #1014, R-1014-1).
 *
 * The hard case has not changed, only the mechanism under it: a row leaving a
 * filter projects as a DELETE decided from the state BEFORE the oldest change
 * the page shows for it. That state used to be reconstructed by retention
 * compaction's `prior_op` / `prior_old_values_json` pair, which existed because
 * a trigger-log entry was a POINTER and several of them for one row said
 * nothing more than the last. A log row is a full image plus the delta of what
 * the statement changed, so there is nothing to fold — and the property to hold
 * is the one that survived the mechanism: a replay in three-row pages lands
 * byte-identical with a replay in one, and stripping the prior loses the
 * filter-exit delete.
 */
describe("replica projection replay equivalence", () => {
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
    const dir = await tempDir(`replica-replay-${crypto.randomUUID()}-`);
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
    vault.recordAppInstall("planner", {
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
    // The install settles before the replayed window; a register change inside
    // it would rebootstrap instead.
    const granted = currentReplicaLogState(vault.db.vault).watermark;
    const insert = vault.db.vault.prepare(
      `INSERT INTO schedule_task
         (task_id, owner_party_id, title, description, status, priority)
       VALUES (?, ?, ?, ?, 'needs-action', 0)`
    );
    capturedWrite(vault.db.vault, () => {
      for (const id of ["hot-a", "hot-b", "leaver", "doomed"])
        insert.run(id, vault.boot.ownerPartyId, id, "seed");
    });
    const since = currentReplicaLogState(vault.db.vault).watermark;
    const base = replay(vault, granted);

    const retitle = vault.db.vault.prepare(
      `UPDATE schedule_task SET title = ? WHERE task_id = ?`
    );
    const restatus = vault.db.vault.prepare(
      `UPDATE schedule_task SET status = ? WHERE task_id = ?`
    );
    // ONE COMMIT PER TOUCH, so the window carries the churn the page boundary
    // has to be able to fall inside.
    for (let index = 0; index < CHURN; index += 1) {
      capturedWrite(vault.db.vault, () => {
        retitle.run(`hot-a ${index}`, "hot-a");
      });
      capturedWrite(vault.db.vault, () => {
        retitle.run(`hot-b ${index}`, "hot-b");
      });
    }
    // Leaves the filter, then keeps changing: the superseded transition is
    // what a page-size-independent replay must not lose.
    capturedWrite(vault.db.vault, () => {
      restatus.run("completed", "leaver");
    });
    capturedWrite(vault.db.vault, () => {
      retitle.run("leaver later", "leaver");
    });
    capturedWrite(vault.db.vault, () => {
      retitle.run("hot-a last", "hot-a");
    });
    capturedWrite(vault.db.vault, () =>
      vault.db.vault
        .prepare(`DELETE FROM schedule_task WHERE task_id = 'doomed'`)
        .run()
    );
    return { vault, since, base };
  }

  /** In order, last write wins (docs/mobile-offline.md). */
  type ReplicaState = Map<string, { values: unknown; version: number }>;

  function replay(
    vault: VaultPlane,
    since: ReturnType<typeof currentReplicaLogState>["watermark"],
    base: ReplicaState = new Map(),
    limit = 3
  ): ReplicaState {
    const rows: ReplicaState = new Map(base);
    let cursor = since;
    for (let page = 0; page < 500; page += 1) {
      const projected = projectReplicaPage(
        vault.db.vault,
        access,
        cursor,
        limit
      );
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

  /** The bytes two replays must agree on. */
  function snapshot(rows: ReplicaState): string {
    return JSON.stringify(
      [...rows.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, row]) => [key, row.values])
    );
  }

  test("a catch-up replay lands byte-identical at any page size", async () => {
    const { vault, since, base } = await churnedVault();
    // Small on purpose: a change and the one that supersedes it must be able
    // to straddle a page boundary and still converge.
    const paged = snapshot(replay(vault, since, base, 3));
    const single = snapshot(replay(vault, since, base, 1_000));

    expect(paged).toStrictEqual(single);
    expect(paged).toContain("hot-a last");
    expect(paged).not.toContain("leaver");
    expect(paged).not.toContain("doomed");
  });

  test("SABOTAGE: stripping the prior image loses the filter-exit delete", async () => {
    const { vault, since, base } = await churnedVault();
    const expected = snapshot(replay(vault, since, base));
    // The bug this prevents: keep the row's current image, forget what it was
    // before the change — and a row that LEFT the filter reads as a row that
    // was never in it, so no delete is projected and the phone keeps it.
    vault.db.vault.exec(
      `UPDATE replica_log SET prior_json = '{}' WHERE op = 'update'`
    );

    const sabotaged = snapshot(replay(vault, since, base));

    expect(sabotaged).not.toStrictEqual(expected);
    expect(sabotaged).toContain("leaver");
  });

  test("SABOTAGE: dropping a row's delete strands it on the device", async () => {
    const { vault, since, base } = await churnedVault();
    const expected = snapshot(replay(vault, since, base));
    vault.db.vault.exec(
      `DELETE FROM replica_log
        WHERE op = 'delete' AND pk_json = '["doomed"]'`
    );

    const sabotaged = snapshot(replay(vault, since, base));

    expect(sabotaged).not.toStrictEqual(expected);
    expect(sabotaged).toContain("doomed");
  });
});

// #922 0b, ruling SB-text: text a screen renders rides the replica lane in
// FULL up to the ceiling its entity declares. Before this the projection
// stripped any value over a flat 64 KiB and listed it as deferred, so a note
// body past roughly 48 KiB of prose reached no device and nothing fetched it
// back. `core.content_item` is where a note body actually lives — a `data:`
// URI in `content_uri` — which is why it is the entity that declares.
describe("replica projection of declared long text", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  test("a note body over the old 64 KiB cap reaches the device in full", async () => {
    const dir = await tempDir(`replica-long-text-${crypto.randomUUID()}-`);
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
    vault.recordAppInstall("planner", {
      scopes: [
        {
          schema: "core",
          table: "content_item",
          verbs: "read",
          fieldMask: ["title", "content_uri", "media_type"],
        },
      ],
    });
    const since = currentReplicaLogState(vault.db.vault).watermark;
    const body = "a".repeat(200 * 1_024);
    const uri = `data:text/markdown;base64,${Buffer.from(body, "utf8").toString("base64")}`;
    capturedWrite(vault.db.vault, () =>
      vault.db.vault
        .prepare(
          `INSERT INTO core_content_item
           (content_id, content_uri, sha256, byte_size,
            created_at)
         VALUES ('long-note', ?, ?, ?,
                 '2026-01-01T00:00:00.000Z')`
        )
        .run(uri, "f".repeat(64), Buffer.byteLength(body))
    );

    const page = projectReplicaPage(vault.db.vault, access, since);
    const change = page.batch.changes.find(
      (candidate) =>
        candidate.op === "upsert" && candidate.entity === "core.content_item"
    );
    expect(change).toStrictEqual(
      expect.objectContaining({
        op: "upsert",
        values: expect.objectContaining({ content_uri: uri }),
      })
    );
    expect(change).not.toHaveProperty("oversizedFields");
  });
});
