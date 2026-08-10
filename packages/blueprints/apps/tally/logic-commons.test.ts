// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";

import { createLogic } from "./logic.ts";
import type { AppState, Dash } from "./types.ts";

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
    pendingExpenses: [],
    dismissedCommonsIntentIds: new Set(),
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

describe("Tally durable Commons overlay", () => {
  test("rebuilds a canonical pending add-expense intent after reload", async () => {
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        commonsIntents: vi.fn<
          NonNullable<typeof window.centraid.commonsIntents>
        >(async () => [
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
              splits: [
                { party_id: "party-alice", share_minor: 300 },
                { party_id: "party-bob", share_minor: 300 },
              ],
            },
            status: "parked",
            reason: "waiting for Alice's device",
            stewardLabel: "Alice's device",
            createdAt: "2026-08-10T00:00:00.000Z",
          },
        ]),
      },
    });
    const appState = state();
    const logic = createLogic({
      state: appState,
      dash: dash(),
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.refreshCommonsExpenses();

    expect(appState.pendingExpenses).toStrictEqual([
      expect.objectContaining({
        expense_id: "commons-intent-lunch",
        group_id: "group-trip",
        description: "Lunch",
        pending: true,
        parked: true,
        intentStatus: "parked",
        pendingReason: "waiting for Alice's device",
        stewardLabel: "Alice's device",
      }),
    ]);
  });

  // Issue #731 m6: a denied intent never ages out of `commonsIntents()` on
  // its own (unlike an executed write), so without a client-side dismissal
  // it would keep re-appearing in the overlay on every refresh forever.
  test("dismissCommonsIntent clears a denied row immediately and keeps it gone across refreshes", async () => {
    const deniedIntent = {
      intentId: "intent-taxi",
      grantId: "grant-trip",
      actorPartyId: "party-bob",
      command: "tally.add_expense" as const,
      input: {
        group_id: "group-trip",
        description: "Taxi",
        amount_minor: 1200,
        paid_by: "party-bob",
        category: "transport",
        spent_on: "2026-08-10",
        splits: [{ party_id: "party-bob", share_minor: 1200 }],
      },
      status: "denied" as const,
      reason: "Alice's device does not allow this split.",
      stewardLabel: "Alice's device",
      createdAt: "2026-08-10T00:00:00.000Z",
    };
    const commonsIntents =
      vi.fn<NonNullable<typeof window.centraid.commonsIntents>>();
    commonsIntents.mockResolvedValue([deniedIntent]);
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { commonsIntents },
    });
    const appState = state();
    const render = vi.fn<() => void>();
    const logic = createLogic({
      state: appState,
      dash: dash(),
      render,
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.refreshCommonsExpenses();
    expect(appState.pendingExpenses).toHaveLength(1);
    expect(appState.pendingExpenses[0]?.intentStatus).toBe("denied");

    logic.dismissCommonsIntent("intent-taxi");
    expect(appState.pendingExpenses).toStrictEqual([]);
    expect(appState.dismissedCommonsIntentIds.has("intent-taxi")).toBe(true);
    expect(render).toHaveBeenCalledWith();

    // The gateway still hands back the same denied intent on the next
    // refresh (nothing about it changed server-side) — the dismissal must
    // still hold it out of the overlay.
    await logic.refreshCommonsExpenses();
    expect(appState.pendingExpenses).toStrictEqual([]);
  });

  test("dismissCommonsIntent is a no-op for a pending/parked row — only a settled denial is dismissible", async () => {
    const commonsIntents =
      vi.fn<NonNullable<typeof window.centraid.commonsIntents>>();
    commonsIntents.mockResolvedValue([
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
          splits: [{ party_id: "party-bob", share_minor: 600 }],
        },
        status: "parked",
        reason: "waiting for Alice's device",
        stewardLabel: "Alice's device",
        createdAt: "2026-08-10T00:00:00.000Z",
      },
    ]);
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { commonsIntents },
    });
    const appState = state();
    const logic = createLogic({
      state: appState,
      dash: dash(),
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.refreshCommonsExpenses();
    logic.dismissCommonsIntent("intent-lunch");

    expect(appState.pendingExpenses).toHaveLength(1);
    expect(appState.dismissedCommonsIntentIds.size).toBe(0);
  });
});
