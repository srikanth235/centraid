// The pending-overlay engine's own law, branch by branch (#839 W2-1).
//
// `pending-overlay.test.ts` beside this file asserts the engine THROUGH three
// real app declarations — it proves Tasks, Tally and Locker agree with each
// other. That leaves the engine's own edges unasserted, and they are the edges
// every seat depends on: what a projection does when it is handed the wrong
// app, what a row missing one overlay field is read as, what copy a status
// with no reason earns, and which statuses may still be retried or discarded.
//
// A seat's honest local read is replica ⊕ outbox. Every branch below is a way
// that read can lie — a row that keeps a stale status, a terminal write that
// re-expires, a denial that offers no way out — so each is pinned as its own
// case rather than through a rendered surface.
import { describe, expect, it } from "vitest";

import {
  PENDING_OVERLAY_FIELDS,
  decoratePendingMutation,
  definePendingProjection,
  enrichPendingRows,
  expirePendingOverlay,
  pendingChangeLabel,
  pendingInputValues,
  pendingOverlayCanDiscard,
  pendingOverlayCanRetry,
  pendingOverlayCopy,
  pendingPatch,
  pendingUpsert,
  projectPendingWrite,
  readPendingOverlay,
  settlePendingOverlay,
  stablePendingRowId,
} from "./pending-overlay.ts";
import type {
  PendingOverlayPresentation,
  PendingOverlayStatus,
  PendingProjectionMutation,
} from "./pending-overlay.ts";

const ALL_STATUSES: readonly PendingOverlayStatus[] = [
  "queued",
  "sending",
  "parked",
  "denied",
  "conflict",
  "failed",
  "expired",
  "cancelled",
];

function presentation(
  patch: Partial<PendingOverlayPresentation> = {}
): PendingOverlayPresentation {
  return { key: "intent-1", status: "queued", action: "add", ...patch };
}

function row(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PENDING_OVERLAY_FIELDS.key]: "intent-1",
    [PENDING_OVERLAY_FIELDS.status]: "queued",
    [PENDING_OVERLAY_FIELDS.action]: "add",
    ...patch,
  };
}

describe("a synthetic row id is derived, never invented twice", () => {
  it("namespaces the intent so it can never collide with a vault row id", () => {
    expect(stablePendingRowId("intent-1")).toBe("pending:intent-1:row");
  });

  it("names each row of a multi-row projection apart", () => {
    expect(stablePendingRowId("intent-1", "split-0")).toBe(
      "pending:intent-1:split-0"
    );
    expect(stablePendingRowId("intent-1", "split-0")).not.toBe(
      stablePendingRowId("intent-1", "split-1")
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
          rowId: "pending:intent-1:row",
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
    const decorated = decoratePendingMutation(upsert, {
      intentId: "i1",
      state: "awaiting-change",
      action: "add",
    });
    expect(decorated.op).toBe("upsert");
    if (decorated.op !== "upsert") return;
    expect(decorated.values[PENDING_OVERLAY_FIELDS.status]).toBe("sending");
    expect(decorated.values[PENDING_OVERLAY_FIELDS.reason]).toBe(
      "Sending this change."
    );
  });

  it("gives queued its own standing sentence", () => {
    const decorated = decoratePendingMutation(upsert, {
      intentId: "i1",
      state: "queued",
      action: "add",
    });
    if (decorated.op !== "upsert") throw new Error("expected an upsert");
    expect(decorated.values[PENDING_OVERLAY_FIELDS.reason]).toBe(
      "Waiting for a connection."
    );
    expect(decorated.values[PENDING_OVERLAY_FIELDS.key]).toBe("i1");
    expect(decorated.values[PENDING_OVERLAY_FIELDS.action]).toBe("add");
  });

  it("keeps the intent's own reason over the standing one", () => {
    const decorated = decoratePendingMutation(upsert, {
      intentId: "i1",
      state: "queued",
      action: "add",
      reason: "Waiting for the kitchen tablet.",
    });
    if (decorated.op !== "upsert") throw new Error("expected an upsert");
    expect(decorated.values[PENDING_OVERLAY_FIELDS.reason]).toBe(
      "Waiting for the kitchen tablet."
    );
  });

  it("carries NO reason for a terminal state that named none", () => {
    const decorated = decoratePendingMutation(upsert, {
      intentId: "i1",
      state: "denied",
      action: "add",
    });
    if (decorated.op !== "upsert") throw new Error("expected an upsert");
    expect(PENDING_OVERLAY_FIELDS.reason in decorated.values).toBe(false);
  });

  it("keeps the projected values beside the overlay fields", () => {
    const decorated = decoratePendingMutation(upsert, {
      intentId: "i1",
      state: "queued",
      action: "add",
    });
    if (decorated.op !== "upsert") throw new Error("expected an upsert");
    expect(decorated.values.title).toBe("Book train");
  });

  it("writes both version numbers only when a conflict named them", () => {
    const clean = decoratePendingMutation(upsert, {
      intentId: "i1",
      state: "conflict",
      action: "add",
    });
    if (clean.op !== "upsert") throw new Error("expected an upsert");
    expect(PENDING_OVERLAY_FIELDS.expectedVersion in clean.values).toBe(false);

    const versioned = decoratePendingMutation(upsert, {
      intentId: "i1",
      state: "conflict",
      action: "add",
      conflict: { expectedVersion: 4, actualVersion: 7 },
    });
    if (versioned.op !== "upsert") throw new Error("expected an upsert");
    expect(versioned.values[PENDING_OVERLAY_FIELDS.expectedVersion]).toBe(4);
    expect(versioned.values[PENDING_OVERLAY_FIELDS.actualVersion]).toBe(7);
  });
});

describe("reading an overlay back off a row", () => {
  it("reads nothing from a row that is not there", () => {
    expect(readPendingOverlay(undefined)).toBeUndefined();
  });

  it("reads nothing from an ordinary vault row", () => {
    expect(
      readPendingOverlay({ task_id: "t1", title: "Book train" })
    ).toBeUndefined();
  });

  it("requires all three of key, status and action", () => {
    expect(
      readPendingOverlay(row({ [PENDING_OVERLAY_FIELDS.key]: 7 }))
    ).toBeUndefined();
    expect(
      readPendingOverlay(row({ [PENDING_OVERLAY_FIELDS.action]: null }))
    ).toBeUndefined();
    expect(
      readPendingOverlay(row({ [PENDING_OVERLAY_FIELDS.status]: "nonsense" }))
    ).toBeUndefined();
  });

  it("accepts every status the engine names, and only those", () => {
    for (const status of ALL_STATUSES) {
      expect(
        readPendingOverlay(row({ [PENDING_OVERLAY_FIELDS.status]: status }))
          ?.status
      ).toBe(status);
    }
    expect(
      readPendingOverlay(row({ [PENDING_OVERLAY_FIELDS.status]: "executed" }))
    ).toBeUndefined();
  });

  it("omits an optional field rather than carrying a wrongly-typed one", () => {
    const read = readPendingOverlay(
      row({
        [PENDING_OVERLAY_FIELDS.reason]: 42,
        [PENDING_OVERLAY_FIELDS.steward]: null,
        [PENDING_OVERLAY_FIELDS.expectedVersion]: "4",
        [PENDING_OVERLAY_FIELDS.actualVersion]: "7",
      })
    );
    expect(read).toStrictEqual({
      key: "intent-1",
      status: "queued",
      action: "add",
    });
  });

  it("carries every optional field that IS well typed", () => {
    expect(
      readPendingOverlay(
        row({
          [PENDING_OVERLAY_FIELDS.reason]: "Because.",
          [PENDING_OVERLAY_FIELDS.steward]: "Asha's phone",
          [PENDING_OVERLAY_FIELDS.expectedVersion]: 4,
          [PENDING_OVERLAY_FIELDS.actualVersion]: 7,
        })
      )
    ).toStrictEqual({
      key: "intent-1",
      status: "queued",
      action: "add",
      reason: "Because.",
      stewardLabel: "Asha's phone",
      expectedVersion: 4,
      actualVersion: 7,
    });
  });
});

describe("what a pending row says", () => {
  it("gives queued and sending their own standing sentences", () => {
    expect(pendingOverlayCopy(presentation({ status: "queued" }))).toBe(
      "Waiting for a connection."
    );
    expect(pendingOverlayCopy(presentation({ status: "sending" }))).toBe(
      "Sending this change."
    );
  });

  it("ignores a reason on queued and sending — those states are not explanations", () => {
    expect(
      pendingOverlayCopy(presentation({ status: "queued", reason: "hmm" }))
    ).toBe("Waiting for a connection.");
  });

  it("names the steward for a park, in preference to any reason", () => {
    expect(
      pendingOverlayCopy(
        presentation({
          status: "parked",
          stewardLabel: "Asha's phone",
          reason: "some other sentence",
        })
      )
    ).toBe("Waiting for Asha's phone.");
  });

  it("falls back to the reason, then to the owner, for a park with no steward", () => {
    expect(
      pendingOverlayCopy(
        presentation({ status: "parked", reason: "Held for review." })
      )
    ).toBe("Held for review.");
    expect(pendingOverlayCopy(presentation({ status: "parked" }))).toBe(
      "Waiting for the owner to approve this change."
    );
  });

  it("appends both version numbers to a conflict, or neither", () => {
    expect(
      pendingOverlayCopy(
        presentation({
          status: "conflict",
          reason: "This row changed on another seat.",
          expectedVersion: 4,
          actualVersion: 7,
        })
      )
    ).toBe("This row changed on another seat. Expected version 4; found 7.");
    expect(
      pendingOverlayCopy(
        presentation({ status: "conflict", expectedVersion: 4 })
      )
    ).toBe("This row changed somewhere else.");
    expect(
      pendingOverlayCopy(presentation({ status: "conflict", actualVersion: 7 }))
    ).toBe("This row changed somewhere else.");
  });

  it("says something for every terminal state, reason or not", () => {
    for (const status of [
      "denied",
      "failed",
      "expired",
      "cancelled",
    ] as const) {
      expect(pendingOverlayCopy(presentation({ status }))).toBe(
        "This change was not applied."
      );
      expect(
        pendingOverlayCopy(presentation({ status, reason: "Not allowed." }))
      ).toBe("Not allowed.");
    }
  });

  it("prefixes the badge label, and prefixes it once", () => {
    expect(pendingChangeLabel(presentation({ status: "sending" }))).toBe(
      "Pending change: Sending this change."
    );
  });
});

describe("what a member may still do about it", () => {
  it("offers a retry for exactly the three recoverable refusals", () => {
    const retryable = ALL_STATUSES.filter((status) =>
      pendingOverlayCanRetry(presentation({ status }))
    );
    expect(retryable).toStrictEqual(["denied", "conflict", "failed"]);
  });

  it("offers a discard for every state that has stopped moving", () => {
    const discardable = ALL_STATUSES.filter((status) =>
      pendingOverlayCanDiscard(presentation({ status }))
    );
    expect(discardable).toStrictEqual([
      "denied",
      "conflict",
      "failed",
      "expired",
      "cancelled",
    ]);
  });

  it("never offers either while the write is still on its way", () => {
    for (const status of ["queued", "sending", "parked"] as const) {
      expect(pendingOverlayCanRetry(presentation({ status }))).toBe(false);
      expect(pendingOverlayCanDiscard(presentation({ status }))).toBe(false);
    }
  });
});

describe("settlement is a visible-row transition, not a deletion", () => {
  const parked = presentation({
    status: "parked",
    stewardLabel: "Asha's phone",
    reason: "Held.",
  });

  it("removes the projection only on executed", () => {
    expect(
      settlePendingOverlay(parked, { status: "executed" })
    ).toBeUndefined();
  });

  it("keeps the key and action across the transition", () => {
    expect(settlePendingOverlay(parked, { status: "denied" })).toMatchObject({
      key: "intent-1",
      action: "add",
      status: "denied",
    });
  });

  it("keeps what the settlement did not name, and replaces what it did", () => {
    expect(settlePendingOverlay(parked, { status: "denied" })?.reason).toBe(
      "Held."
    );
    expect(
      settlePendingOverlay(parked, { status: "denied", reason: "No grant." })
        ?.reason
    ).toBe("No grant.");
    expect(
      settlePendingOverlay(parked, {
        status: "denied",
        stewardLabel: "Ravi's laptop",
      })?.stewardLabel
    ).toBe("Ravi's laptop");
  });

  it("carries conflict versions in only when the settlement carried them", () => {
    expect(
      settlePendingOverlay(parked, {
        status: "conflict",
        expectedVersion: 4,
        actualVersion: 7,
      })
    ).toMatchObject({ expectedVersion: 4, actualVersion: 7 });
    const bare = settlePendingOverlay(parked, { status: "conflict" })!;
    expect("expectedVersion" in bare).toBe(false);
    expect("actualVersion" in bare).toBe(false);
  });
});

describe("expiry is terminal, and only reachable from a live state", () => {
  it("expires a write that was still on its way", () => {
    for (const status of ["queued", "sending", "parked"] as const) {
      expect(expirePendingOverlay(presentation({ status })).status).toBe(
        "expired"
      );
    }
  });

  it("carries its own standing sentence when given no reason", () => {
    expect(
      expirePendingOverlay(presentation({ status: "queued" })).reason
    ).toBe("This pending write expired before it could be applied.");
  });

  it("leaves an already-settled row EXACTLY as it was", () => {
    for (const status of [
      "denied",
      "conflict",
      "failed",
      "expired",
      "cancelled",
    ] as const) {
      const settled = presentation({ status, reason: "Already decided." });
      expect(expirePendingOverlay(settled)).toBe(settled);
    }
  });
});

describe("enriching rows from elsewhere", () => {
  it("leaves an ordinary vault row untouched", () => {
    const plain = { task_id: "t1" };
    expect(
      enrichPendingRows([plain], [{ intentId: "intent-1", status: "denied" }])
    ).toStrictEqual([plain]);
  });

  it("leaves a pending row no enrichment names untouched", () => {
    const pending = row();
    expect(
      enrichPendingRows([pending], [{ intentId: "other", status: "denied" }])
    ).toStrictEqual([pending]);
  });

  it("moves a row back to queued or sending without settling it", () => {
    const [moved] = enrichPendingRows(
      [row({ [PENDING_OVERLAY_FIELDS.status]: "parked" })],
      [{ intentId: "intent-1", status: "sending" }]
    );
    expect(moved?.[PENDING_OVERLAY_FIELDS.status]).toBe("sending");
  });

  it("settles a row through the same law settlement uses", () => {
    const [settled] = enrichPendingRows(
      [row({ [PENDING_OVERLAY_FIELDS.status]: "parked" })],
      [
        {
          intentId: "intent-1",
          status: "expired",
          reason: "The review window ended.",
          stewardLabel: "Asha's phone",
        },
      ]
    );
    expect(settled?.[PENDING_OVERLAY_FIELDS.status]).toBe("expired");
    expect(settled?.[PENDING_OVERLAY_FIELDS.reason]).toBe(
      "The review window ended."
    );
    expect(settled?.[PENDING_OVERLAY_FIELDS.steward]).toBe("Asha's phone");
  });

  it("applies copy alone when the enrichment names no status", () => {
    const [enriched] = enrichPendingRows(
      [row({ [PENDING_OVERLAY_FIELDS.status]: "parked" })],
      [{ intentId: "intent-1", stewardLabel: "Asha's phone" }]
    );
    expect(enriched?.[PENDING_OVERLAY_FIELDS.status]).toBe("parked");
    expect(enriched?.[PENDING_OVERLAY_FIELDS.steward]).toBeUndefined();
  });

  it("keeps every other column of the row it enriched", () => {
    const [enriched] = enrichPendingRows(
      [
        {
          ...row(),
          expense_id: "pending:intent-1:expense",
          amount_minor: 1200,
        },
      ],
      [{ intentId: "intent-1", status: "failed", reason: "Refused." }]
    );
    expect(enriched).toMatchObject({
      expense_id: "pending:intent-1:expense",
      amount_minor: 1200,
    });
  });

  it("enriches each row against its OWN intent, across a mixed window", () => {
    const rows = [
      row({ [PENDING_OVERLAY_FIELDS.key]: "a" }),
      row({ [PENDING_OVERLAY_FIELDS.key]: "b" }),
      { task_id: "plain" },
    ];
    const enriched = enrichPendingRows(rows, [
      { intentId: "b", status: "denied", reason: "No grant." },
    ]);
    expect(enriched[0]?.[PENDING_OVERLAY_FIELDS.status]).toBe("queued");
    expect(enriched[1]?.[PENDING_OVERLAY_FIELDS.status]).toBe("denied");
    expect(enriched[2]).toStrictEqual({ task_id: "plain" });
  });
});
