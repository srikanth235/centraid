import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { lockerPendingProjection } from "../locker/pending-projection.ts";
import { photosPendingProjection } from "../photos/pending-projection.ts";
import { tallyPendingProjection } from "../tally/pending-projection.ts";
import { tasksPendingProjection } from "../tasks/pending-projection.ts";
import {
  PENDING_OVERLAY_FIELDS,
  decoratePendingMutation,
  expirePendingOverlay,
  pendingOverlayCanDiscard,
  pendingOverlayCanRetry,
  pendingOverlayCopy,
  projectPendingWrite,
  readPendingOverlay,
  stablePendingRowId,
  enrichPendingRows,
  settlePendingOverlay,
} from "./pending-overlay.ts";
import {
  PENDING_PROJECTION_APP_IDS,
  pendingProjectionFor,
} from "./pending-projections.ts";

describe("pending-write overlay law", () => {
  test("Tasks and Tally use the same deterministic projection path", () => {
    const task = projectPendingWrite(tasksPendingProjection, {
      appId: "tasks",
      action: "add",
      input: { title: "Book train" },
      intentId: "intent-1",
    });
    const expense = projectPendingWrite(tallyPendingProjection, {
      appId: "tally",
      action: "add-expense",
      input: {
        group_id: "trip",
        description: "Train",
        amount_minor: 1200,
        paid_by: "me",
        splits: [{ party_id: "me", share_minor: 1200 }],
      },
      intentId: "intent-1",
    });

    expect(task.optimistic[0]).toMatchObject({
      entity: "schedule.task",
      rowId: stablePendingRowId("intent-1", "task"),
    });
    expect(expense.optimistic.map((row) => row.rowId)).toStrictEqual([
      stablePendingRowId("intent-1", "expense"),
      stablePendingRowId("intent-1", "payer-0"),
      stablePendingRowId("intent-1", "split-0"),
    ]);
    expect(expense.optimistic[1]).toMatchObject({
      entity: "tally.expense_payer",
      values: {
        expense_id: stablePendingRowId("intent-1", "expense"),
        party_id: "me",
        paid_minor: 1200,
      },
    });
    expect(
      projectPendingWrite(tasksPendingProjection, {
        appId: "tasks",
        action: "add",
        input: { title: "Book train" },
        intentId: "intent-1",
      })
    ).toStrictEqual(task);
  });

  test("Photos update-asset projects only columns that live on media.asset", () => {
    const recaption = projectPendingWrite(photosPendingProjection, {
      appId: "photos",
      action: "update-asset",
      input: {
        asset_id: "asset-e2e-readiness-probe",
        title: "readiness-probe",
      },
      intentId: "photos-e2e-readiness-probe",
    });
    expect(recaption.optimistic).toStrictEqual([
      {
        op: "upsert",
        entity: "media.asset",
        rowId: "asset-e2e-readiness-probe",
        values: {},
      },
    ]);

    const favorite = projectPendingWrite(photosPendingProjection, {
      appId: "photos",
      action: "update-asset",
      input: { asset_id: "asset-1", favorite: 1 },
      intentId: "photos-favorite",
    });
    expect(favorite.optimistic[0]).toMatchObject({
      entity: "media.asset",
      rowId: "asset-1",
      values: { favorite: 1 },
    });
    expect(
      favorite.optimistic[0] &&
        favorite.optimistic[0].op === "upsert" &&
        "title" in favorite.optimistic[0].values
    ).toBe(false);
  });

  test("Locker secrets are excluded while ordinary item actions remain visible", () => {
    const secret = projectPendingWrite(lockerPendingProjection, {
      appId: "locker",
      action: "add-item",
      input: { title: "Bank", password: "do-not-persist" },
      intentId: "intent-secret",
    });
    const star = projectPendingWrite(lockerPendingProjection, {
      appId: "locker",
      action: "star-item",
      input: { item_id: "locker-1" },
      intentId: "intent-star",
    });

    expect(secret.optimistic).toStrictEqual([]);
    expect(star.optimistic).toStrictEqual([
      {
        op: "upsert",
        entity: "locker.item",
        rowId: "locker-1",
        values: {},
      },
    ]);
  });

  test("status decoration is derived from the durable intent on every read", () => {
    const projected = projectPendingWrite(tasksPendingProjection, {
      appId: "tasks",
      action: "add",
      input: { title: "Book train" },
      intentId: "intent-conflict",
    }).optimistic[0]!;
    const conflict = decoratePendingMutation(projected, {
      intentId: "intent-conflict",
      state: "conflict",
      action: "add",
      reason: "The task changed on another seat.",
      conflict: { expectedVersion: 4, actualVersion: 7 },
    });
    expect(conflict.op).toBe("upsert");
    if (conflict.op !== "upsert") return;
    const pending = readPendingOverlay(conflict.values);

    expect(pending).toMatchObject({
      key: "intent-conflict",
      status: "conflict",
      expectedVersion: 4,
      actualVersion: 7,
    });
    expect(pendingOverlayCopy(pending!)).toContain(
      "Expected version 4; found 7."
    );
    expect(pendingOverlayCanRetry(pending!)).toBe(true);
    expect(pendingOverlayCanDiscard(pending!)).toBe(true);
  });

  test("queued and parked rows use the shared quiet/reason grammar", () => {
    const row = {
      [PENDING_OVERLAY_FIELDS.key]: "intent-2",
      [PENDING_OVERLAY_FIELDS.status]: "parked",
      [PENDING_OVERLAY_FIELDS.action]: "rsvp",
      [PENDING_OVERLAY_FIELDS.steward]: "Asha's phone",
    };
    expect(pendingOverlayCopy(readPendingOverlay(row)!)).toBe(
      "Waiting for Asha's phone."
    );
  });

  test("an empty Commons enrichment cannot wipe an outbox row", () => {
    const rows = [
      {
        expense_id: stablePendingRowId("intent-solo", "expense"),
        [PENDING_OVERLAY_FIELDS.key]: "intent-solo",
        [PENDING_OVERLAY_FIELDS.status]: "queued",
        [PENDING_OVERLAY_FIELDS.action]: "add-expense",
      },
    ];

    expect(enrichPendingRows(rows, [])).toStrictEqual(rows);
  });

  test("settlement and expiry are pure visible-row transitions", () => {
    const parked = readPendingOverlay({
      [PENDING_OVERLAY_FIELDS.key]: "intent-commons",
      [PENDING_OVERLAY_FIELDS.status]: "parked",
      [PENDING_OVERLAY_FIELDS.action]: "add-expense",
      [PENDING_OVERLAY_FIELDS.steward]: "Asha's phone",
    })!;

    expect(
      settlePendingOverlay(parked, { status: "executed" })
    ).toBeUndefined();
    expect(
      expirePendingOverlay(parked, "The 14-day review window ended.")
    ).toMatchObject({
      key: "intent-commons",
      status: "expired",
      reason: "The 14-day review window ended.",
      stewardLabel: "Asha's phone",
    });
    expect(
      settlePendingOverlay(parked, {
        status: "conflict",
        reason: "The row changed.",
        expectedVersion: 4,
        actualVersion: 7,
      })
    ).toMatchObject({
      status: "conflict",
      expectedVersion: 4,
      actualVersion: 7,
    });
  });

  test("Commons enrichment can settle copy without owning row membership", () => {
    const row = {
      expense_id: stablePendingRowId("intent-expired", "expense"),
      [PENDING_OVERLAY_FIELDS.key]: "intent-expired",
      [PENDING_OVERLAY_FIELDS.status]: "parked",
      [PENDING_OVERLAY_FIELDS.action]: "add-expense",
    };

    const [expired] = enrichPendingRows(
      [row],
      [
        {
          intentId: "intent-expired",
          status: "expired",
          reason: "The review window ended.",
        },
      ]
    );
    expect(readPendingOverlay(expired)).toMatchObject({
      key: "intent-expired",
      status: "expired",
      reason: "The review window ended.",
    });
    expect(enrichPendingRows([row], [])).toHaveLength(1);
  });

  test("[law:pending-overlay] all eight blueprints declare every action", () => {
    expect(PENDING_PROJECTION_APP_IDS).toStrictEqual([
      "agenda",
      "docs",
      "locker",
      "notes",
      "people",
      "photos",
      "tally",
      "tasks",
    ]);
    for (const appId of PENDING_PROJECTION_APP_IDS) {
      const declaration = pendingProjectionFor(appId)!;
      const manifest = JSON.parse(
        readFileSync(new URL(`../${appId}/app.json`, import.meta.url), "utf8")
      ) as { actions: Array<{ name: string }> };
      expect(Object.keys(declaration.actions).toSorted()).toStrictEqual(
        manifest.actions.map((action) => action.name).toSorted()
      );
      for (const projection of Object.values(declaration.actions)) {
        if (typeof projection === "function") continue;
        expect(projection.reason.trim().length).toBeGreaterThan(20);
      }
    }
  });

  // #922 G9: an old queued change says WHEN it was saved on this device, and
  // nothing about that number expires the intent — only the sentence changes.
  test("a badge older than 24 h names the day it was saved", () => {
    const enqueuedAt = "2026-09-01T09:00:00.000Z";
    const fresh = pendingOverlayCopy(
      { key: "i", status: "queued", action: "add", enqueuedAt },
      Date.parse("2026-09-01T20:00:00.000Z")
    );
    expect(fresh).toBe("Waiting for a connection.");
    const aged = pendingOverlayCopy(
      { key: "i", status: "queued", action: "add", enqueuedAt },
      Date.parse("2026-09-03T09:00:00.000Z")
    );
    expect(aged).toContain("Waiting for a connection.");
    expect(aged).toContain("Saved on this device on");
    // A queued intent with no stamp still reads as waiting, never as expired.
    expect(
      pendingOverlayCopy(
        { key: "i", status: "queued", action: "add" },
        Date.parse("2030-01-01T00:00:00.000Z")
      )
    ).toBe("Waiting for a connection.");
  });

  test("the two new verdicts read as sentences, not database words", () => {
    expect(
      pendingOverlayCopy({
        key: "i",
        status: "conflict-base-missing",
        action: "edit",
      })
    ).toContain("is gone");
    expect(
      pendingOverlayCopy({ key: "i", status: "expired", action: "edit" })
    ).toContain("waited too long");
  });
});
