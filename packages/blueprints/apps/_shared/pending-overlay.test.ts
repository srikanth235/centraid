import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { lockerPendingProjection } from "../locker/pending-projection.ts";
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
      rowId: "pending:intent-1:task",
    });
    expect(expense.optimistic.map((row) => row.rowId)).toStrictEqual([
      "pending:intent-1:expense",
      "pending:intent-1:split-0",
    ]);
    expect(
      projectPendingWrite(tasksPendingProjection, {
        appId: "tasks",
        action: "add",
        input: { title: "Book train" },
        intentId: "intent-1",
      })
    ).toStrictEqual(task);
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
        expense_id: "pending:intent-solo:expense",
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
      expense_id: "pending:intent-expired:expense",
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
});
