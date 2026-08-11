// @vitest-environment jsdom
//
// The Tally half of issue #738's migration to the shared pending-write
// overlay engine. `createLogic` no longer owns any overlay state itself —
// these tests exercise the wiring around `createPendingOverlayModel`
// (packages/blueprints/apps/_shared/pending-overlay.ts, whose own laws are
// covered by pending-overlay.test.ts): reload-rebuild from the durable
// outbox, decorating a query's own row with the pending chip fields, and
// Commons as enrichment-only (never a rebuild).

import { describe, expect, test, vi } from "vitest";

import { pendingRowId } from "../_shared/pending-overlay.ts";
import { createLogic, decorateLedgerRow } from "./logic.ts";
import type { AppState, Dash, LedgerRow } from "./types.ts";

function state(): AppState {
  return {
    view: "dashboard",
    groupId: null,
    friendId: null,
    search: "",
    searchStatus: "resting",
    narrow: false,
    viewData: null,
    detail: null,
    expense: null,
    settle: null,
    newGroup: null,
    addFriend: null,
    expenseUndo: null,
    modalMembers: [],
  };
}

function dash(): Dash {
  return {
    me: "party-bob",
    currency: "USD",
    friends: [],
    groups: [
      {
        group_id: "group-trip",
        name: "Trip",
        member_count: 2,
        owner_net_minor: 0,
      },
    ],
    trash: [],
    recurring: [],
    owe_total_minor: 0,
    owed_total_minor: 0,
  };
}

function stubCentraid(value: Partial<CentraidClient>) {
  Object.defineProperty(window, "centraid", { configurable: true, value });
}

function newLogic() {
  return createLogic({
    state: state(),
    dash: dash(),
    render: vi.fn<() => void>(),
    renderModals: vi.fn<() => void>(),
    loadView: vi.fn<() => Promise<void>>(async () => undefined),
    refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
  });
}

describe("Tally pending-write overlay (issue #738)", () => {
  test("restorePendingWrites rebuilds a parked add-expense row from the durable outbox on reload", async () => {
    stubCentraid({
      pendingWrites: vi.fn<NonNullable<CentraidClient["pendingWrites"]>>(
        async () => [
          {
            intentId: "intent-lunch",
            action: "add-expense",
            state: "parked",
            reason: "waiting for Alice's device",
            input: {
              group_id: "group-trip",
              description: "Lunch",
              amount_minor: 600,
              paid_by: "party-bob",
              category: "food",
              spent_on: "2026-08-10",
            },
            mutations: [],
          },
        ]
      ),
    });
    const logic = newLogic();

    await logic.restorePendingWrites();

    const entry = logic.pendingByRowId().get(pendingRowId("intent-lunch"));
    expect(entry).toMatchObject({
      intentId: "intent-lunch",
      action: "add-expense",
      status: "parked",
      reason: "waiting for Alice's device",
    });
  });

  // Reload survival: the durable outbox alone is enough for the ledger's
  // own pending row to render — no gateway round trip, no app-owned state.
  test("a queued add-expense intent from pendingWrites() decorates the query's own composed ledger row as pending", async () => {
    const rowId = pendingRowId("intent-taxi");
    stubCentraid({
      pendingWrites: vi.fn<NonNullable<CentraidClient["pendingWrites"]>>(
        async () => [
          {
            intentId: "intent-taxi",
            action: "add-expense",
            state: "queued",
            input: {
              group_id: "group-trip",
              description: "Taxi",
              amount_minor: 1200,
              paid_by: "party-bob",
              category: "transport",
              spent_on: "2026-08-10",
            },
            mutations: [
              {
                op: "upsert",
                entity: "tally.expense",
                rowId,
                values: {
                  expense_id: rowId,
                  group_id: "group-trip",
                  description: "Taxi",
                  amount_minor: 1200,
                  paid_by: "party-bob",
                  category: "transport",
                  spent_on: "2026-08-10",
                },
              },
            ],
          },
        ]
      ),
    });
    const logic = newLogic();

    await logic.restorePendingWrites();

    // What the group/friend ledger query would already return, composed
    // from the outbox by the replica's own overlay (packages/client) — the
    // app never rebuilds this row, it only decorates it.
    const fetchedRow: LedgerRow = {
      expense_id: rowId,
      group_id: "group-trip",
      description: "Taxi",
      amount_minor: 1200,
      category: "transport",
      spent_on: "2026-08-10",
      paid_by: "party-bob",
      your_role: "lent",
      your_amount_minor: 1200,
      splits: [],
    };
    const decorated = decorateLedgerRow(fetchedRow, logic.pendingByRowId());
    expect(decorated.pending).toBe(true);
    expect(decorated.parked).toBe(false);
    expect(decorated.pendingStatus).toBe("queued");
    expect(decorated.commonsIntentId).toBe("intent-taxi");
  });

  // Issue #731 m6: a denied intent never ages out of `commonsIntents()` on
  // its own (unlike an executed write), so without a dismissal it would keep
  // re-appearing in the enrichment on every refresh forever.
  test("dismissCommonsIntent clears a denied commons-enrichment row and keeps it gone across re-enrichment", async () => {
    const deniedIntent = {
      intentId: "intent-taxi",
      grantId: "grant-trip",
      actorPartyId: "party-bob",
      command: "tally.add_expense",
      input: {
        group_id: "group-trip",
        description: "Taxi",
        amount_minor: 1200,
        paid_by: "party-bob",
        category: "transport",
        spent_on: "2026-08-10",
      },
      status: "denied" as const,
      reason: "Alice's device does not allow this split.",
      stewardLabel: "Alice's device",
      createdAt: "2026-08-10T00:00:00.000Z",
    };
    const commonsIntents = vi.fn<NonNullable<CentraidClient["commonsIntents"]>>(
      async () => [deniedIntent]
    );
    stubCentraid({ commonsIntents });
    const render = vi.fn<() => void>();
    const logic = createLogic({
      state: state(),
      dash: dash(),
      render,
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.enrichCommons();
    // Asserting the row's CONTENT, not just its count: a commons intent names
    // the vault command (`tally.add_expense`), not the app action, so a row
    // that renders empty — or not at all — is the failure mode this test
    // exists to catch.
    const [enriched] = logic.pendingLedgerRows();
    expect(enriched).toMatchObject({
      description: "Taxi",
      amount_minor: 1200,
      commonsIntentId: "intent-taxi",
      stewardLabel: "Alice's device",
      pendingReason: "Alice's device does not allow this split.",
    });

    logic.dismissCommonsIntent("intent-taxi");
    expect(logic.pendingLedgerRows()).toStrictEqual([]);
    expect(render).toHaveBeenCalledWith();

    // The gateway still hands back the same denied intent on the next
    // enrichment (nothing about it changed server-side) — the dismissal
    // must still hold it out of the overlay.
    await logic.enrichCommons();
    expect(logic.pendingLedgerRows()).toStrictEqual([]);
  });

  test("dismissCommonsIntent is a no-op for a parked row — only a settled denial is dismissible", async () => {
    stubCentraid({
      commonsIntents: vi.fn<NonNullable<CentraidClient["commonsIntents"]>>(
        async () => [
          {
            intentId: "intent-lunch",
            grantId: "grant-trip",
            actorPartyId: "party-bob",
            command: "tally.add_expense",
            input: {
              group_id: "group-trip",
              description: "Lunch",
              amount_minor: 600,
              paid_by: "party-bob",
              category: "food",
              spent_on: "2026-08-10",
            },
            status: "parked",
            reason: "waiting for Alice's device",
            stewardLabel: "Alice's device",
            createdAt: "2026-08-10T00:00:00.000Z",
          },
        ]
      ),
    });
    const logic = newLogic();

    await logic.enrichCommons();
    logic.dismissCommonsIntent("intent-lunch");

    expect(logic.pendingLedgerRows()).toHaveLength(1);
  });

  // Issue #738 regression: the solo-vault wipe. `refreshCommonsExpenses`
  // used to rebuild `state.pendingExpenses` wholesale from
  // `commonsIntents()`, so a member with no Commons grant at all — an empty
  // answer, or offline — saw their own just-queued add vanish on every
  // refresh. `enrichCommons()` may only ADD information now, never rebuild.
  test("an empty commonsIntents() answer never clears a locally-queued pending row", async () => {
    stubCentraid({
      write: vi.fn<() => Promise<VaultOutcome>>(
        async () => ({ status: "queued" }) as VaultOutcome
      ) as CentraidClient["write"],
      commonsIntents: vi.fn<NonNullable<CentraidClient["commonsIntents"]>>(
        async () => []
      ),
    });
    const logic = newLogic();

    await logic.act("add-expense", {
      group_id: "group-trip",
      description: "Lunch",
      amount_minor: 600,
      paid_by: "party-bob",
      category: "food",
      spent_on: "2026-08-10",
    });
    expect(logic.pendingByRowId().size).toBe(1);

    await logic.enrichCommons();
    expect(logic.pendingByRowId().size).toBe(1);
  });
});
