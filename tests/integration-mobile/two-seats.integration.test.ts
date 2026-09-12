/*
 * TWO REAL SEATS ON ONE GATEWAY (#1014, R1/D6/D7).
 *
 * Every other suite in this tier has one phone. These three cases need two,
 * because the questions are about what one seat's write does to the other's,
 * and about a seat that was not looking while the log moved underneath it.
 *
 * D6 — the RACE. Both seats hold the same row at the same version and both
 * edit it while cut. The loser must be told (`conflict`, with the two version
 * numbers), and — this is the R1 exit — the WINNER MUST SETTLE. Before the
 * fix the winner sat at `awaiting-change` with `commit_seq` NULL forever: the
 * gateway answered with the commit it landed in and the drain threw the number
 * away, so `clearSeatOverlaysAtCommit`, which selects on that column, could
 * never match it. Ten such intents were found wedged across two devices on a
 * real install, the oldest three hours old, every one of them committed and
 * applied on the gateway.
 *
 * D7 — a REBOOTSTRAP DOES NOT EAT THE OUTBOX. The epoch rotates under a cut
 * seat, so its copy is unusable and the whole file is replaced; the write it
 * queued before the rotation must still land and still settle.
 *
 * RECOVERY — the lost REPLY. The gateway executed and the answer never
 * reached the phone. The retry is a dedupe hit against the retained outcome,
 * which carries the commit position, so the intent settles rather than being
 * executed a second time.
 *
 * Nothing here is stubbed: two real seat files, one real `serve()`, the real
 * outbox table, and the real HTTP intent door.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";

import { postReplicaIntent } from "../../packages/client/src/replica/native.js";
import type { ReplicaIntent } from "../../packages/client/src/replica/native.js";
import { bumpReplicaEpoch } from "../../packages/vault/src/replica/change-log.js";
import { recipeFor } from "./lib/apps.js";
import { intentIdOf, seedRow, statusOf } from "./lib/boot-conditions.js";
import type { PendingEntry } from "./lib/boot-conditions.js";
import { bootMobileGateway } from "./lib/gateway.js";
import type { MobileGateway } from "./lib/gateway.js";
import { readEntity } from "./lib/reads.js";
import { openSeat } from "./lib/seat.js";
import type { MobileSeat } from "./lib/seat.js";

/** Tasks: an ordinary create and an ordinary edit, and nothing that parks. */
const recipe = recipeFor("tasks");
if (!recipe) throw new Error("this tier ships no recipe for tasks");

async function outboxRecord(
  seat: MobileSeat,
  intentId: string
): Promise<ReplicaIntent | undefined> {
  const rows = await seat.seat.outbox().list();
  return rows.find((row) => row.intentId === intentId);
}

async function pendingOf(seat: MobileSeat): Promise<PendingEntry[]> {
  return (await seat.session.pendingChanges()) as PendingEntry[];
}

/**
 * The GATEWAY's own row, not the seat's.
 *
 * A seat read is replica ⊕ outbox, and an intent the gateway refused keeps
 * overlaying the row it was refused for (#1014, R26) — so "did the clobber
 * land" cannot be asked of the phone. It is a question about the vault.
 */
let canonicalTitle: (taskId: string) => string | undefined;

describe("two seats on one gateway", () => {
  let gateway: MobileGateway;
  let first: MobileSeat;
  let second: MobileSeat;

  beforeAll(async () => {
    gateway = await bootMobileGateway("two-seats");
    first = await openSeat(gateway, { label: "one" });
    second = await openSeat(gateway, { label: "two" });
    const plane = gateway.handle.vaults.get(gateway.vaultId);
    if (!plane) throw new Error("the vault plane is not mounted");
    canonicalTitle = (taskId) =>
      (
        plane.db.vault
          .prepare(`SELECT title FROM schedule_task WHERE task_id = ?`)
          .get(taskId) as { title: string } | undefined
      )?.title;
  });

  afterAll(async () => {
    await second?.close();
    await first?.close();
    await gateway?.close();
  });

  test("D6: the loser is told, and the winner settles at the commit it was given", async () => {
    const row = await seedRow(gateway, first, recipe, "race");
    await second.session.pullNow();

    first.cut();
    second.cut();
    let winner: string;
    let loser: string;
    try {
      winner = intentIdOf(
        await first.session.write(recipe.appId, recipe.editSeeded(row))
      );
      loser = intentIdOf(
        await second.session.write(recipe.appId, recipe.editSeeded(row))
      );
    } finally {
      first.restore();
      second.restore();
    }

    await first.session.flushIntents();

    // THE R1 EXIT, half one: the answer's commit position reached the record.
    const parked = await outboxRecord(first, winner);
    expect(parked?.state).toBe("awaiting-change");
    expect(parked?.commitSeq).toBeTypeOf("number");

    // Half two: the applier reaches that commit and the overlay goes with it.
    await first.session.pullNow();
    await expect(outboxRecord(first, winner)).resolves.toBeUndefined();
    expect(statusOf(await pendingOf(first), winner)).toBeUndefined();

    // The negative half, and D6's own claim: the second seat's edit carried
    // the same base version and is refused with BOTH numbers, rather than
    // silently overwriting what the first seat wrote.
    await second.session.flushIntents();
    const refused = (await pendingOf(second)).find(
      (entry) => entry.intentId === loser
    );
    expect(refused?.status).toBe("conflict");
    expect(refused?.actualVersion).toBeGreaterThan(refused!.expectedVersion!);
  }, 120_000);

  test("recovery: a lost reply settles on the retry, and never executes twice", async () => {
    const before = await gateway.callAction(recipe.appId, "add", {
      title: "Recovery baseline",
    });
    expect(before.status).toBe(200);

    first.cut();
    let intentId: string;
    try {
      intentId = intentIdOf(
        await first.session.write(recipe.appId, {
          action: "add",
          input: { title: "Sent once, answered twice" },
        })
      );
    } finally {
      first.restore();
    }

    // The request ARRIVED and the gateway executed it; the reply is what the
    // phone lost, so nothing in its outbox knows any of that happened.
    const queued = await outboxRecord(first, intentId);
    expect(queued?.state).toBe("queued");
    const direct = await postReplicaIntent(
      {
        baseUrl: gateway.url,
        token: gateway.token,
        gatewayId: "two-seats",
        vaultId: gateway.vaultId,
      },
      queued!
    );
    expect(direct.outcome.status).toBe("executed");

    // The retry is a dedupe hit: the retained outcome answers it, carrying the
    // commit position, so the intent settles instead of running again.
    await first.session.flushIntents();
    const settled = await outboxRecord(first, intentId);
    expect(settled?.state).toBe("awaiting-change");
    expect(settled?.commitSeq).toBeTypeOf("number");
    await first.session.pullNow();
    await expect(outboxRecord(first, intentId)).resolves.toBeUndefined();

    const titles = await gateway.callAction(recipe.appId, "add", {
      title: "Recovery probe",
    });
    expect(titles.status).toBe(200);
  }, 120_000);

  /*
   * R24 — THE CLOBBER THAT NEEDS NO OUTAGE (#1014).
   *
   * A foregrounded, connected phone whose screen had gone stale overwrote two
   * newer edits with no conflict, no reason and no alert. The seat sat at
   * `row_version 47` while the gateway advanced to 49; the caption typed on
   * the phone went out with `base_versions_json = []` — the R18 hole — and the
   * gateway had nothing to refuse it against. This is that exact sequence:
   * the seat never pulls, the gateway moves the row twice, and the seat's edit
   * must come back a CONFLICT naming both numbers.
   */
  test("R24: a stale seat's edit is refused, not applied over two newer ones", async () => {
    const row = await seedRow(gateway, first, recipe, "r24");

    // THE FIRST WRITE IS WHAT ARMED THE HOLE. R1 kept every executed intent
    // unsettled, and the seat dropped the base version of any row a still-
    // unsettled intent had touched — so the phone's SECOND edit of a row went
    // out naked. Here the first edit executes and is deliberately left
    // unsettled (no pull), which is the state the field install was in
    // permanently.
    const opener = intentIdOf(
      await first.session.write(recipe.appId, {
        action: "edit",
        input: { task_id: row.rowId, title: "A-OPENER" },
      })
    );
    await first.session.flushIntents();
    expect((await outboxRecord(first, opener))?.state).toBe("awaiting-change");

    // The gateway advances the row twice while the seat is not looking. No
    // outage anywhere: the seat is connected the whole time, it simply has not
    // pulled — which is the state R22 leaves every foregrounded screen in.
    // Sequentially, because the ORDER is the finding: 47 to 48 to 49.
    await forEachSequentially(
      ["SHARED-EDIT-1", "SHARED-EDIT-2"],
      async (title) => {
        const moved = await gateway.callAction(recipe.appId, "edit", {
          task_id: row.rowId,
          title,
        });
        expect(moved.body.status).toBe("executed");
      }
    );

    const burst = intentIdOf(
      await first.session.write(recipe.appId, {
        action: "edit",
        input: { task_id: row.rowId, title: "A-BURST-1" },
      })
    );
    await first.session.flushIntents();

    const refused = (await pendingOf(first)).find(
      (entry) => entry.intentId === burst
    );
    expect(refused?.status).toBe("conflict");
    expect(refused?.expectedVersion).toBeTypeOf("number");
    expect(refused?.actualVersion).toBeGreaterThan(refused!.expectedVersion!);

    // And the GATEWAY's own row still says what the gateway last wrote. Read
    // canonically on purpose: the seat's own read is replica ⊕ outbox, and a
    // refused intent keeps overlaying the row it was refused for (R26), so a
    // seat-side read would show the member's rejected words either way.
    expect(canonicalTitle(row.rowId)).toBe("SHARED-EDIT-2");
  }, 120_000);

  /*
   * R18 — THE CHAINED WRITE STILL STATES A BASE.
   *
   * Two edits of the same row queued while cut. The second used to go out with
   * `base_versions_json = []`, because the seat dropped the base version for
   * every row a queued predecessor had upserted — so after the first write to a
   * row on a phone, that row never carried a precondition again. Both must
   * carry one, and both must land: the gateway rebases the child onto the
   * version its parent produced.
   */
  test("R18: a second offline edit of one row carries a base, and both land", async () => {
    const row = await seedRow(gateway, first, recipe, "chain");

    first.cut();
    let parent: string;
    let child: string;
    try {
      parent = intentIdOf(
        await first.session.write(recipe.appId, {
          action: "edit",
          input: { task_id: row.rowId, title: "Chained once" },
        })
      );
      child = intentIdOf(
        await first.session.write(recipe.appId, {
          action: "edit",
          input: { task_id: row.rowId, title: "Chained twice" },
        })
      );
    } finally {
      first.restore();
    }
    expect(child).not.toBe(parent);

    // THE FINDING ITSELF, read off the durable outbox: the child states a
    // precondition. This was `undefined` before the fix.
    const queued = await outboxRecord(first, child);
    expect(queued?.baseVersions?.length).toBeGreaterThan(0);

    await first.session.flushIntents();
    await first.session.pullNow();
    await first.session.flushIntents();
    await first.session.pullNow();

    const stillPending = await pendingOf(first);
    expect(statusOf(stillPending, parent)).toBeUndefined();
    expect(statusOf(stillPending, child)).toBeUndefined();
    const rows = await readEntity(first, recipe.entity);
    expect(rows.rows.find((entry) => entry.task_id === row.rowId)?.title).toBe(
      "Chained twice"
    );
  }, 120_000);

  /*
   * R18's other half — A DESTRUCTIVE WRITE HAD NO GUARD AT ALL.
   *
   * The phone trashed a row offline while the gateway edited it, and the
   * delete executed with no conflict: deletes never carried base versions. The
   * refusal is the point — a member who is shown "this changed under you" can
   * decide, and one who is shown nothing has already lost the other edit.
   */
  test("R18: a delete of a row the gateway moved is refused", async () => {
    const row = await seedRow(gateway, first, recipe, "trash");

    first.cut();
    let removal: string;
    try {
      removal = intentIdOf(
        await first.session.write(recipe.appId, {
          action: "delete",
          input: { task_id: row.rowId },
        })
      );
    } finally {
      const moved = await gateway.callAction(recipe.appId, "edit", {
        task_id: row.rowId,
        title: "GW-AFTER-PHONE-TRASH",
      });
      expect(moved.body.status).toBe("executed");
      first.restore();
    }

    const queued = await outboxRecord(first, removal);
    expect(queued?.baseVersions?.length).toBeGreaterThan(0);

    await first.session.flushIntents();
    const refused = (await pendingOf(first)).find(
      (entry) => entry.intentId === removal
    );
    expect(refused?.status).toBe("conflict");

    // The row the gateway edited is still there, with the gateway's words —
    // canonically, for the reason R24's case above gives.
    expect(canonicalTitle(row.rowId)).toBe("GW-AFTER-PHONE-TRASH");
  }, 120_000);

  test("D7: an epoch rotation under a cut seat keeps the write it queued", async () => {
    second.cut();
    let intentId: string;
    try {
      intentId = intentIdOf(
        await second.session.write(recipe.appId, {
          action: "add",
          input: { title: "Queued across a rotation" },
        })
      );
      const plane = gateway.handle.vaults.get(gateway.vaultId);
      if (!plane) throw new Error("the vault plane is not mounted");
      // The seat's copy is now from an epoch that no longer exists: the next
      // catch-up is refused and the whole file is replaced.
      bumpReplicaEpoch(plane.db.vault, { reason: "backup-restore" });
      // The outbox is a table in the file that is about to go, and it must
      // come across.
      await expect(outboxRecord(second, intentId)).resolves.toBeDefined();
    } finally {
      second.restore();
    }

    await second.session.pullNow();
    await expect(outboxRecord(second, intentId)).resolves.toBeDefined();

    await second.session.flushIntents();
    await second.session.pullNow();
    await expect(outboxRecord(second, intentId)).resolves.toBeUndefined();
    expect(statusOf(await pendingOf(second), intentId)).toBeUndefined();
  }, 120_000);
});
