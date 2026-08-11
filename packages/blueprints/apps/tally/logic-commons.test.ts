// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";

import { PENDING_OVERLAY_FIELDS } from "../_shared/pending-overlay.ts";
import { createLogic } from "./logic.ts";
import type { AppState, Dash, LedgerRow } from "./types.ts";

const pendingRow: LedgerRow = {
  expense_id: "pending:intent-lunch:expense",
  group_id: "group-trip",
  description: "Lunch",
  amount_minor: 600,
  paid_by: "party-bob",
  paid_by_name: "Bob",
  category: "food",
  spent_on: "2026-08-10",
  splits: [{ party_id: "party-bob", share_minor: 600 }],
  your_role: "lent",
  your_amount_minor: 0,
  pending: true,
  parked: true,
  intentStatus: "parked",
  commonsIntentId: "intent-lunch",
  __centraidScopeId: "family-vault",
  [PENDING_OVERLAY_FIELDS.key]: "intent-lunch",
  [PENDING_OVERLAY_FIELDS.status]: "parked",
  [PENDING_OVERLAY_FIELDS.action]: "add-expense",
} as LedgerRow;

function state(): AppState {
  return {
    view: "group",
    groupId: "group-trip",
    friendId: null,
    search: "",
    searchStatus: "resting",
    narrow: false,
    viewData: { ledger: [{ ...pendingRow }] },
    detail: null,
    expense: null,
    settle: null,
    newGroup: null,
    addFriend: null,
    expenseUndo: null,
    modalMembers: [],
  };
}

const dash: Dash = {
  me: "party-bob",
  currency: "USD",
  friends: [],
  groups: [],
  trash: [],
  recurring: [],
  owe_total_minor: 0,
  owed_total_minor: 0,
};

describe("Tally Commons pending-row enrichment", () => {
  test("editing a terminal pending expense revises its synthetic row in one write", async () => {
    document.body.innerHTML =
      '<div id="noticeBanner" hidden></div><div id="statusLine"></div>';
    const write = vi.fn<
      (request: {
        action: string;
        input?: Record<string, unknown>;
      }) => Promise<{ intentId: string; status: "queued" }>
    >(async () => ({
      intentId: "intent-lunch",
      status: "queued",
    }));
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        read: vi.fn<
          () => Promise<{
            me: string;
            members: Array<{
              color: string;
              initials: string;
              name: string;
              party_id: string;
            }>;
          }>
        >(async () => ({
          me: "party-bob",
          members: [
            {
              color: "blue",
              initials: "B",
              name: "Bob",
              party_id: "party-bob",
            },
          ],
        })),
        write,
      },
    });
    const logic = createLogic({
      state: state(),
      dash,
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.openEditExpense({
      ...pendingRow,
      intentStatus: "failed",
      parked: false,
    });
    await logic.saveExpense();

    expect(write).toHaveBeenCalledExactlyOnceWith({
      action: "edit-expense",
      input: expect.objectContaining({
        description: "Lunch",
        expense_id: "pending:intent-lunch:expense",
      }),
    });
  });

  test("an empty solo-vault Commons result cannot wipe the outbox row", async () => {
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        commonsIntents: vi.fn<NonNullable<CentraidClient["commonsIntents"]>>(
          async () => []
        ),
      },
    });
    const appState = state();
    const logic = createLogic({
      state: appState,
      dash,
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.refreshCommonsExpenses();

    expect(appState.viewData?.ledger).toStrictEqual([pendingRow]);
  });

  test("enriches an outbox-projected row but never creates a second overlay", async () => {
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        commonsIntents: vi.fn<NonNullable<CentraidClient["commonsIntents"]>>(
          async () => [
            {
              intentId: "intent-lunch",
              grantId: "grant-trip",
              actorPartyId: "party-bob",
              command: "tally.add_expense",
              input: {},
              status: "parked",
              reason: "Waiting for Alice's device.",
              stewardLabel: "Alice's device",
              createdAt: "2026-08-10T00:00:00.000Z",
            },
            {
              intentId: "server-only",
              grantId: "grant-trip",
              actorPartyId: "party-bob",
              command: "tally.add_expense",
              input: { description: "Must not appear" },
              status: "parked",
              createdAt: "2026-08-10T00:00:00.000Z",
            },
          ]
        ),
      },
    });
    const appState = state();
    const logic = createLogic({
      state: appState,
      dash,
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.refreshCommonsExpenses();

    expect(appState.viewData?.ledger).toHaveLength(1);
    expect(appState.viewData?.ledger?.[0]).toMatchObject({
      pendingReason: "Waiting for Alice's device.",
      stewardLabel: "Alice's device",
      intentStatus: "parked",
    });
  });

  test("preserves Commons expiry as a dismissible transition on the outbox row", async () => {
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        commonsIntents: vi.fn<NonNullable<CentraidClient["commonsIntents"]>>(
          async () => [
            {
              intentId: "intent-lunch",
              grantId: "grant-trip",
              actorPartyId: "party-bob",
              command: "tally.add_expense",
              input: {},
              status: "expired",
              reason: "The 14-day review window ended.",
              createdAt: "2026-07-20T00:00:00.000Z",
            },
          ]
        ),
      },
    });
    const appState = state();
    const logic = createLogic({
      state: appState,
      dash,
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.refreshCommonsExpenses();

    expect(appState.viewData?.ledger).toHaveLength(1);
    expect(appState.viewData?.ledger?.[0]).toMatchObject({
      intentStatus: "expired",
      pendingReason: "The 14-day review window ended.",
    });
  });

  test("dismiss and retry delegate to durable outbox settlement", async () => {
    const discardPendingWrite = vi.fn<
      (intentId: string, scope?: string) => Promise<boolean>
    >(async () => true);
    const retryPendingWrite = vi.fn<
      (intentId: string, scope?: string) => Promise<boolean>
    >(async () => true);
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { discardPendingWrite, retryPendingWrite },
    });
    const refreshAll = vi.fn<() => Promise<void>>(async () => undefined);
    const logic = createLogic({
      state: state(),
      dash,
      render: vi.fn<() => void>(),
      renderModals: vi.fn<() => void>(),
      loadView: vi.fn<() => Promise<void>>(async () => undefined),
      refreshAll,
    });

    await logic.dismissCommonsIntent("intent-lunch", "family-vault");
    await logic.retryPendingIntent("intent-denied", "family-vault");

    expect(discardPendingWrite).toHaveBeenCalledWith(
      "intent-lunch",
      "family-vault"
    );
    expect(retryPendingWrite).toHaveBeenCalledWith(
      "intent-denied",
      "family-vault"
    );
    expect(refreshAll).toHaveBeenCalledTimes(2);
  });
});
