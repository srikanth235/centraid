// The pending-overlay engine's law on the WRITE side, branch by branch
// (#839 W2-1): the synthetic row id it derives, the projection builders, what
// one write projects, and how a mutation is decorated at read time. What a
// decorated row then SAYS, and what a member may still do about it, is the
// sibling `pending-overlay-presentation.test.ts`.
//
// `pending-overlay.test.ts` beside this file asserts the engine THROUGH three
// real app declarations — it proves Tasks, Tally and Locker agree with each
// other. That leaves the engine's own edges unasserted, and they are the edges
// every seat depends on: what a projection does when it is handed the wrong
// app, what a structural exclusion projects, and which fields a decoration is
// allowed to invent.
//
// A seat's honest local read is replica ⊕ outbox. Every branch below is a way
// that read can lie — a projection that escapes its own app, a delete that
// grows a chip it has no row to carry, a terminal state that invents a reason
// nobody gave — so each is pinned as its own case rather than through a
// rendered surface.
import { describe, expect, it } from "vitest";

import {
  PENDING_OVERLAY_FIELDS,
  pendingOverlayFacts,
  decoratePendingMutation,
  definePendingProjection,
  pendingInputValues,
  pendingPatch,
  pendingUpsert,
  projectPendingWrite,
  stablePendingRowId,
} from "./pending-overlay.ts";
import type { PendingProjectionMutation } from "./pending-overlay.ts";

describe("a synthetic row id is derived, never invented twice", () => {
  // #922 G2: the id IS the row's id, so it is canonical in shape and the
  // origin can honour it. It no longer spells the intent that minted it —
  // pendingness is the overlay's own column on the row.
  it("is a canonical id, not a spelling that says pending", () => {
    expect(stablePendingRowId("intent-1")).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/u
    );
    expect(stablePendingRowId("intent-1")).not.toContain("pending:");
  });

  it("names each row of a multi-row projection apart", () => {
    expect(stablePendingRowId("intent-1", "split-0")).not.toBe(
      stablePendingRowId("intent-1", "split-1")
    );
    expect(stablePendingRowId("intent-1", "split-0")).not.toBe(
      stablePendingRowId("intent-2", "split-0")
    );
  });

  it("is stable for the same intent — a re-read must not move the row", () => {
    expect(stablePendingRowId("intent-1", "task")).toBe(
      stablePendingRowId("intent-1", "task")
    );
  });
});

describe("the projection builders", () => {
  it("builds an upsert with exactly the values it was given", () => {
    expect(
      pendingUpsert("schedule.task", "r1", { title: "Book train" })
    ).toStrictEqual({
      op: "upsert",
      entity: "schedule.task",
      rowId: "r1",
      values: { title: "Book train" },
    });
  });

  it("hands the declaration straight back, unchanged", () => {
    const declaration = { appId: "tasks", actions: {} };
    expect(definePendingProjection(declaration)).toBe(declaration);
  });

  it("projects NOTHING rather than a row with no id", () => {
    expect(
      pendingPatch("schedule.task", undefined, { title: "x" }, ["title"])
    ).toStrictEqual([]);
    expect(
      pendingPatch("schedule.task", "", { title: "x" }, ["title"])
    ).toStrictEqual([]);
    expect(
      pendingPatch("schedule.task", 7, { title: "x" }, ["title"])
    ).toStrictEqual([]);
  });

  it("copies only the named keys — a patch is not the whole input", () => {
    expect(
      pendingPatch(
        "schedule.task",
        "r1",
        { title: "New", secret: "do-not-persist" },
        ["title"]
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "schedule.task",
        rowId: "r1",
        values: { title: "New" },
      },
    ]);
  });

  it("names no keys at all by default, which is an empty patch", () => {
    expect(pendingPatch("schedule.task", "r1", { title: "New" })).toStrictEqual(
      [{ op: "upsert", entity: "schedule.task", rowId: "r1", values: {} }]
    );
  });

  it("carries every JSON-shaped value and drops everything else", () => {
    const values = pendingInputValues(
      {
        text: "a",
        count: 1,
        flag: false,
        empty: null,
        list: [1, "two", { deep: true }],
        nested: { a: { b: [null] } },
        fn: () => {},
        sym: Symbol("nope"),
        undef: undefined,
        badList: [1, () => {}],
        badNested: { a: () => {} },
      },
      [
        "text",
        "count",
        "flag",
        "empty",
        "list",
        "nested",
        "fn",
        "sym",
        "undef",
        "badList",
        "badNested",
        "absent",
      ]
    );
    expect(Object.keys(values).toSorted()).toStrictEqual([
      "count",
      "empty",
      "flag",
      "list",
      "nested",
      "text",
    ]);
    expect(values.list).toStrictEqual([1, "two", { deep: true }]);
  });
});

describe("projecting one write", () => {
  const declaration = definePendingProjection({
    appId: "tasks",
    actions: {
      add: (context) => [
        pendingUpsert("schedule.task", stablePendingRowId(context.intentId), {
          title: String(context.input.title ?? ""),
        }),
      ],
      "add-versioned": (context) => ({
        optimistic: [
          pendingUpsert(
            "schedule.task",
            stablePendingRowId(context.intentId),
            {}
          ),
        ],
        baseVersions: [{ entity: "schedule.task", rowId: "r1", version: 3 }],
      }),
      "add-unversioned": () => ({ optimistic: [] }),
      "reveal-secret": {
        excluded: true,
        reason: "A revealed secret must never be written to a replica row.",
      },
    },
  });

  const context = {
    appId: "tasks",
    action: "add",
    input: { title: "Book train" },
    intentId: "intent-1",
  };

  it("projects nothing at all when no app declared anything", () => {
    expect(projectPendingWrite(undefined, context)).toStrictEqual({
      optimistic: [],
    });
  });

  it("refuses to project ANOTHER app's declaration over this app's write", () => {
    expect(
      projectPendingWrite(declaration, { ...context, appId: "notes" })
    ).toStrictEqual({ optimistic: [] });
  });

  it("projects nothing for an action the declaration does not name", () => {
    expect(
      projectPendingWrite(declaration, { ...context, action: "unknown" })
    ).toStrictEqual({ optimistic: [] });
  });

  it("treats a structural exclusion as nothing to paint, not as a projection", () => {
    expect(
      projectPendingWrite(declaration, { ...context, action: "reveal-secret" })
    ).toStrictEqual({ optimistic: [] });
  });

  it("wraps a bare mutation array as the optimistic set", () => {
    expect(projectPendingWrite(declaration, context)).toStrictEqual({
      optimistic: [
        {
          op: "upsert",
          entity: "schedule.task",
          rowId: stablePendingRowId("intent-1"),
          values: { title: "Book train" },
        },
      ],
    });
  });

  it("carries base versions through when the projection claimed some", () => {
    const result = projectPendingWrite(declaration, {
      ...context,
      action: "add-versioned",
    });
    expect(result.baseVersions).toStrictEqual([
      { entity: "schedule.task", rowId: "r1", version: 3 },
    ]);
  });

  it("omits the key entirely when the projection claimed none", () => {
    const result = projectPendingWrite(declaration, {
      ...context,
      action: "add-unversioned",
    });
    expect("baseVersions" in result).toBe(false);
  });
});

describe("decorating a mutation at read time", () => {
  const upsert: PendingProjectionMutation = pendingUpsert("e", "r1", {
    title: "Book train",
  });

  it("never decorates a delete — there is no row left to carry a chip", () => {
    const del: PendingProjectionMutation = {
      op: "delete",
      entity: "e",
      rowId: "r1",
    };
    expect(
      decoratePendingMutation(del, {
        intentId: "i1",
        state: "queued",
        action: "add",
      })
    ).toStrictEqual(del);
  });

  it("never decorates an intent that already executed", () => {
    expect(
      decoratePendingMutation(upsert, {
        intentId: "i1",
        state: "executed",
        action: "add",
      })
    ).toStrictEqual(upsert);
  });

  it("reads awaiting-change as SENDING, not as a state of its own", () => {
    const facts = pendingOverlayFacts({
      intentId: "i1",
      state: "awaiting-change",
      action: "add",
    });
    expect(facts).toMatchObject({
      status: "sending",
      reason: "Sending this change.",
    });
  });

  it("puts ONE pending column on the row and keeps the rest off it", () => {
    const decorated = decoratePendingMutation(upsert, {
      intentId: "i1",
      state: "conflict",
      action: "add",
      reason: "The row changed.",
      attempts: 4,
      enqueuedAt: "2026-08-27T09:00:00.000Z",
      conflict: { expectedVersion: 4, actualVersion: 7 },
    });
    if (decorated.op !== "upsert") throw new Error("expected an upsert");
    // A handler on either seat reads a schema-pure row (#922 G3).
    expect(
      Object.keys(decorated.values).filter((column) =>
        column.startsWith("__centraid_pending")
      )
    ).toStrictEqual([PENDING_OVERLAY_FIELDS.key]);
    expect(decorated.values[PENDING_OVERLAY_FIELDS.key]).toBe("i1");
    expect(decorated.values.title).toBe("Book train");
  });

  it("gives queued its own standing sentence", () => {
    expect(
      pendingOverlayFacts({ intentId: "i1", state: "queued", action: "add" })
    ).toMatchObject({ reason: "Waiting for a connection.", action: "add" });
  });

  it("keeps the intent's own reason over the standing one", () => {
    expect(
      pendingOverlayFacts({
        intentId: "i1",
        state: "queued",
        action: "add",
        reason: "Waiting for the kitchen tablet.",
      })?.reason
    ).toBe("Waiting for the kitchen tablet.");
  });

  it("carries the age and attempt count that separate slow from stuck", () => {
    expect(
      pendingOverlayFacts({
        intentId: "i1",
        state: "queued",
        action: "add",
        attempts: 4,
        enqueuedAt: "2026-08-27T09:00:00.000Z",
      })
    ).toMatchObject({ attempts: 4, enqueuedAt: "2026-08-27T09:00:00.000Z" });
  });

  it("omits the age and attempt count when the rail reported neither", () => {
    const facts = pendingOverlayFacts({
      intentId: "i1",
      state: "queued",
      action: "add",
    })!;
    expect("attempts" in facts).toBe(false);
    expect("enqueuedAt" in facts).toBe(false);
  });

  it("carries NO reason for a terminal state that named none", () => {
    const facts = pendingOverlayFacts({
      intentId: "i1",
      state: "denied",
      action: "add",
    })!;
    expect("reason" in facts).toBe(false);
  });

  it("an executed intent has no sidecar entry at all", () => {
    expect(
      pendingOverlayFacts({ intentId: "i1", state: "executed", action: "add" })
    ).toBeUndefined();
  });

  it("writes both version numbers only when a conflict named them", () => {
    const clean = pendingOverlayFacts({
      intentId: "i1",
      state: "conflict",
      action: "add",
    })!;
    expect("expectedVersion" in clean).toBe(false);

    expect(
      pendingOverlayFacts({
        intentId: "i1",
        state: "conflict",
        action: "add",
        conflict: { expectedVersion: 4, actualVersion: 7 },
      })
    ).toMatchObject({ expectedVersion: 4, actualVersion: 7 });
  });
});
