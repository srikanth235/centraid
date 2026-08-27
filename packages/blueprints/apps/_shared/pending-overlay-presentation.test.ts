// The pending-overlay engine's law on the READ side, branch by branch
// (#839 W2-1): what an overlay is read back as, what the row then says, what a
// member may still do about it, and how it settles or expires. The write side —
// the row id, the projection builders, the decoration — is the sibling
// `pending-overlay-law.test.ts`.
//
// `pending-overlay.test.ts` beside this file asserts the engine THROUGH three
// real app declarations — it proves Tasks, Tally and Locker agree with each
// other. That leaves the engine's own edges unasserted, and they are the edges
// every seat depends on: what a row missing one overlay field is read as, what
// copy a status with no reason earns, and which statuses may still be retried
// or discarded.
//
// A seat's honest local read is replica ⊕ outbox. Every branch below is a way
// that read can lie — a row that keeps a stale status, a terminal write that
// re-expires, a denial that offers no way out — so each is pinned as its own
// case rather than through a rendered surface.
import { describe, expect, it } from "vitest";

import {
  PENDING_OVERLAY_FIELDS,
  enrichPendingRows,
  expirePendingOverlay,
  pendingChangeLabel,
  pendingOverlayCanDiscard,
  pendingOverlayCanRetry,
  pendingOverlayCopy,
  readPendingOverlay,
  settlePendingOverlay,
} from "./pending-overlay.ts";
import type {
  PendingOverlayPresentation,
  PendingOverlayStatus,
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
        [PENDING_OVERLAY_FIELDS.attempts]: "3",
        [PENDING_OVERLAY_FIELDS.enqueuedAt]: 1_770_000_000_000,
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
          [PENDING_OVERLAY_FIELDS.attempts]: 3,
          [PENDING_OVERLAY_FIELDS.enqueuedAt]: "2026-08-27T09:00:00.000Z",
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
      attempts: 3,
      enqueuedAt: "2026-08-27T09:00:00.000Z",
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
