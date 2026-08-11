// The pending-write overlay engine's pure laws (issue #738): projection,
// deterministic pending keys, the status grammar, reload survival from the
// durable outbox, attention persistence, and commons enrichment that only
// ever adds. Pure-function assertions, same convention `search-scaffold.test.ts`
// and `selection-engine.test.ts` use for other `_shared` modules.
import { describe, expect, it } from "vitest";

import {
  createPendingOverlayModel,
  isPendingRowId,
  pendingChipLabel,
  pendingReasonCopy,
  pendingRowId,
  pendingStatusFromIntentState,
  pendingStatusFromOutcome,
  projectPendingMutations,
} from "./pending-overlay.ts";
import type {
  PendingMutation,
  PendingProjectionDeclaration,
} from "./pending-overlay.ts";

const DECLARATION: PendingProjectionDeclaration = {
  appId: "tally",
  actions: {
    "add-expense": (input, ctx) => [
      {
        op: "upsert",
        entity: "tally.expense",
        rowId: ctx.rowId,
        values: {
          expense_id: ctx.rowId,
          description: String(input.description ?? ""),
          amount_minor: Number(input.amount_minor ?? 0),
        },
      },
    ],
    "delete-expense": (input) => [
      {
        op: "delete",
        entity: "tally.expense",
        rowId: String(input.expense_id ?? ""),
      },
    ],
  },
};

describe(projectPendingMutations, () => {
  // [law:pending-overlay-projection] Apps declare projection; they do not implement overlays.
  it("projects a declared action through its pure declaration", () => {
    const mutations = projectPendingMutations(
      DECLARATION,
      "add-expense",
      { description: "Ferry", amount_minor: 1250 },
      "intent-1"
    );
    expect(mutations).toStrictEqual([
      {
        op: "upsert",
        entity: "tally.expense",
        rowId: "pending-intent-1",
        values: {
          expense_id: "pending-intent-1",
          description: "Ferry",
          amount_minor: 1250,
        },
      },
    ]);
  });

  it("projects nothing for an undeclared action — deliberately online-only actions stay overlay-free", () => {
    expect(
      projectPendingMutations(DECLARATION, "reveal-secret", {}, "intent-2")
    ).toStrictEqual([]);
  });
});

describe(pendingRowId, () => {
  // [law:pending-overlay-key] The pending key is deterministic in the intent id.
  it("derives the same row id from the same intent id, with no clock or randomness", () => {
    expect(pendingRowId("abc")).toBe(pendingRowId("abc"));
    expect(pendingRowId("abc")).toBe("pending-abc");
    expect(isPendingRowId(pendingRowId("abc"))).toBe(true);
    expect(isPendingRowId("expense-7")).toBe(false);
    expect(isPendingRowId(42)).toBe(false);
  });
});

describe(pendingStatusFromIntentState, () => {
  it("maps the four unsettled outbox states onto the row grammar and nothing else", () => {
    expect(pendingStatusFromIntentState("queued")).toBe("queued");
    expect(pendingStatusFromIntentState("sending")).toBe("sending");
    expect(pendingStatusFromIntentState("awaiting-change")).toBe("sending");
    expect(pendingStatusFromIntentState("parked")).toBe("parked");
    expect(pendingStatusFromIntentState("executed")).toBeUndefined();
    expect(pendingStatusFromIntentState("denied")).toBeUndefined();
  });
});

describe(pendingStatusFromOutcome, () => {
  it("maps outcomes onto the grammar, conflict winning over its recorded failed state", () => {
    expect(pendingStatusFromOutcome("executed")).toBe("executed");
    expect(pendingStatusFromOutcome("in-flight")).toBe("sending");
    expect(pendingStatusFromOutcome("parked")).toBe("parked");
    expect(pendingStatusFromOutcome("denied")).toBe("denied");
    expect(pendingStatusFromOutcome("failed", true)).toBe("conflict");
    expect(pendingStatusFromOutcome("conflict")).toBe("conflict");
  });
});

describe(pendingReasonCopy, () => {
  // [law:pending-overlay-copy] Honest copy: offline names the connection, online names the steward.
  it("prints a supplied gateway reason verbatim", () => {
    expect(
      pendingReasonCopy("parked", { reason: "confirmation required" })
    ).toBe("confirmation required");
  });

  it("says a parked commons write offline is waiting for a connection, and online names the steward", () => {
    expect(pendingReasonCopy("parked", { online: false })).toBe(
      "Saved on this device; waiting for a connection."
    );
    expect(
      pendingReasonCopy("parked", { online: true, stewardLabel: "Priya" })
    ).toBe("Waiting for Priya.");
    expect(pendingReasonCopy("parked", { online: true })).toBe(
      "Waiting for approval."
    );
  });

  it("gives every status a sentence — a chip never appears without a reason available", () => {
    for (const status of [
      "queued",
      "sending",
      "parked",
      "denied",
      "conflict",
      "failed",
    ] as const) {
      expect(pendingReasonCopy(status).length).toBeGreaterThan(0);
      expect(pendingChipLabel(status).length).toBeGreaterThan(0);
    }
  });
});

describe(createPendingOverlayModel, () => {
  it("begins a declared write as a queued row keyed by the deterministic pending id", () => {
    const model = createPendingOverlayModel(DECLARATION);
    const mutations = model.begin(
      "add-expense",
      { description: "Ferry", amount_minor: 1250 },
      "intent-1"
    );
    expect(mutations).toHaveLength(1);
    const rows = model.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intentId: "intent-1",
      action: "add-expense",
      status: "queued",
      rowIds: ["pending-intent-1"],
      entities: ["tally.expense"],
    });
    expect(model.byRowId().get("pending-intent-1")?.intentId).toBe("intent-1");
  });

  it("begins nothing for an undeclared action", () => {
    const model = createPendingOverlayModel(DECLARATION);
    expect(model.begin("reveal-secret", {}, "intent-1")).toStrictEqual([]);
    expect(model.rows()).toStrictEqual([]);
  });

  // [law:pending-overlay-reload] Overlay survival equals outbox survival.
  it("survives a reload: restore() rebuilds the queued row from the durable outbox alone", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.restore([
      {
        intentId: "intent-1",
        action: "add-expense",
        state: "queued",
        input: { description: "Ferry", amount_minor: 1250 },
      },
    ]);
    const rows = model.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "queued",
      rowIds: ["pending-intent-1"],
    });
  });

  it("prefers durably persisted mutations over re-projection on restore", () => {
    const model = createPendingOverlayModel(DECLARATION);
    const persisted: PendingMutation[] = [
      {
        op: "upsert",
        entity: "tally.expense",
        rowId: "pending-intent-1",
        values: { expense_id: "pending-intent-1", description: "Ferry" },
      },
    ];
    model.restore([
      {
        intentId: "intent-1",
        action: "add-expense",
        state: "parked",
        reason: "confirmation required",
        mutations: persisted,
      },
    ]);
    expect(model.rows()[0]).toMatchObject({
      status: "parked",
      reason: "confirmation required",
      rowIds: ["pending-intent-1"],
    });
  });

  it("drops a row whose durable record settled executed — the canonical row carries it now", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("add-expense", { description: "Ferry" }, "intent-1");
    model.restore([]); // outbox drained: the intent executed and was scrubbed
    expect(model.rows()).toStrictEqual([]);
  });

  it("keeps attention rows (denied/conflict/failed) across restore — settle scrubs the outbox, not the explanation", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("add-expense", { description: "Ferry" }, "intent-1");
    model.applyOutcome("intent-1", {
      status: "denied",
      reason: "not allowed",
    });
    model.restore([]);
    expect(model.rows()).toHaveLength(1);
    expect(model.rows()[0]).toMatchObject({
      status: "denied",
      reason: "not allowed",
    });
  });

  it("settles a row to executed via the change doorbell and removes it", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("add-expense", { description: "Ferry" }, "intent-1");
    expect(
      model.applyChangeDetail({
        source: "overlay",
        intentId: "intent-1",
        intentState: "executed",
      })
    ).toBe(true);
    expect(model.rows()).toStrictEqual([]);
  });

  it("ignores canonical-source bursts and unknown intents", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("add-expense", { description: "Ferry" }, "intent-1");
    expect(
      model.applyChangeDetail({ source: "canonical", intentId: "intent-1" })
    ).toBe(false);
    expect(
      model.applyChangeDetail({
        source: "overlay",
        intentId: "other",
        intentState: "executed",
      })
    ).toBe(false);
    expect(model.rows()).toHaveLength(1);
  });

  // [law:pending-overlay-settlement] Terminal rows persist with reason; discard is explicit.
  it("holds a parked row with its reason until a later outcome settles it", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("add-expense", { description: "Ferry" }, "intent-1");
    model.applyOutcome("intent-1", {
      status: "parked",
      reason: "confirmation required",
    });
    expect(model.rows()[0]).toMatchObject({
      status: "parked",
      reason: "confirmation required",
    });
    expect(model.dismiss("intent-1")).toBe(false); // still waiting: not dismissible
    model.applyOutcome("intent-1", { status: "executed" });
    expect(model.rows()).toStrictEqual([]);
  });

  it("surfaces a conflict with expected vs actual versions, never a generic error", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("delete-expense", { expense_id: "expense-7" }, "intent-1");
    model.applyOutcome("intent-1", {
      status: "failed",
      conflict: {
        entity: "tally.expense",
        rowId: "expense-7",
        expectedVersion: 3,
        actualVersion: 5,
      },
    });
    expect(model.rows()[0]).toMatchObject({
      status: "conflict",
      conflict: { expectedVersion: 3, actualVersion: 5 },
    });
  });

  it("dismisses only attention rows, and a dismissed row stays gone", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("add-expense", { description: "Ferry" }, "intent-1");
    expect(model.dismiss("intent-1")).toBe(false);
    model.applyOutcome("intent-1", { status: "failed", reason: "boom" });
    expect(model.dismiss("intent-1")).toBe(true);
    expect(model.rows()).toStrictEqual([]);
  });

  it("hands a failed row's cached action and input to a retry and drops the entry", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("add-expense", { description: "Ferry" }, "intent-1");
    expect(model.takeForRetry("intent-1")).toBeUndefined(); // still queued
    model.applyOutcome("intent-1", { status: "failed" });
    expect(model.takeForRetry("intent-1")).toStrictEqual({
      action: "add-expense",
      input: { description: "Ferry" },
    });
    expect(model.rows()).toStrictEqual([]);
  });

  it("partitions rows into unsettled and attention views", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("add-expense", { description: "A" }, "intent-1");
    model.begin("add-expense", { description: "B" }, "intent-2");
    model.applyOutcome("intent-2", { status: "denied" });
    expect(model.unsettled().map((row) => row.intentId)).toStrictEqual([
      "intent-1",
    ]);
    expect(model.attention().map((row) => row.intentId)).toStrictEqual([
      "intent-2",
    ]);
  });

  // [law:pending-overlay-enrichment] commonsIntents() is enrichment, not source of truth.
  it("enriches a local row with steward label and per-grant status without touching its mutations", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("add-expense", { description: "Ferry" }, "intent-1");
    model.applyOutcome("intent-1", { status: "parked" });
    model.enrichCommons([
      {
        intentId: "intent-1",
        command: "add-expense",
        status: "parked",
        stewardLabel: "Priya",
        reason: "Waiting for Priya.",
      },
    ]);
    expect(model.rows()[0]).toMatchObject({
      status: "parked",
      stewardLabel: "Priya",
      commonsStatus: "parked",
      reason: "Waiting for Priya.",
      rowIds: ["pending-intent-1"],
    });
  });

  it("never wipes local rows on an empty commons answer — the solo-vault wipe, fixed by construction", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.begin("add-expense", { description: "Ferry" }, "intent-1");
    model.enrichCommons([]);
    expect(model.rows()).toHaveLength(1);
  });

  it("adds enrichment-only rows for server-side intents the outbox does not hold, and keeps them across restore", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.enrichCommons([
      {
        intentId: "remote-1",
        command: "add-expense",
        status: "pending",
        stewardLabel: "Priya",
        input: { description: "Groceries", amount_minor: 900 },
      },
    ]);
    const rows = model.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "parked",
      enrichmentOnly: true,
      stewardLabel: "Priya",
      rowIds: ["pending-remote-1"],
    });
    model.restore([]);
    expect(model.rows()).toHaveLength(1);
  });

  it("lets a settled commons enrichment be dismissed and stay dismissed across re-enrichment (issue #731 m6)", () => {
    const model = createPendingOverlayModel(DECLARATION);
    const settled = {
      intentId: "remote-1",
      command: "add-expense",
      status: "denied",
      reason: "steward said no",
    };
    model.enrichCommons([settled]);
    expect(model.rows()).toHaveLength(1);
    expect(model.dismiss("remote-1")).toBe(true);
    model.enrichCommons([settled]);
    expect(model.rows()).toStrictEqual([]);
  });

  it("never dismisses a live commons pending/parked enrichment — it reappears until terminal", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.enrichCommons([
      { intentId: "remote-1", command: "add-expense", status: "pending" },
    ]);
    expect(model.dismiss("remote-1")).toBe(false);
    expect(model.rows()).toHaveLength(1);
  });

  it("drops executed commons intents from enrichment — server truth carries them", () => {
    const model = createPendingOverlayModel(DECLARATION);
    model.enrichCommons([
      { intentId: "remote-1", command: "add-expense", status: "executed" },
    ]);
    expect(model.rows()).toStrictEqual([]);
  });
});
