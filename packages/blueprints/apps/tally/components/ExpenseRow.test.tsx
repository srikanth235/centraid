// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { LedgerRow } from "../types.ts";
import { ExpenseRow } from "./ExpenseRow.tsx";

const parkedExpense: LedgerRow = {
  expense_id: "pending:intent-lunch:expense",
  group_id: "group-trip",
  description: "Offline lunch",
  amount_minor: 1_250,
  paid_by: "owner",
  paid_by_name: "You",
  category: "food",
  spent_on: "2026-08-11",
  splits: [{ party_id: "owner", share_minor: 1_250 }],
  your_role: "lent",
  your_amount_minor: 1_250,
  pending: true,
  parked: true,
  intentStatus: "parked",
  commonsIntentId: "intent-lunch",
  pendingReason: "Waiting for Alice's device.",
};

describe(ExpenseRow, () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  test("links a parked Commons row to the existing Approvals inbox", async () => {
    const openApprovals = vi.fn<() => void>();
    (window as unknown as { centraid: unknown }).centraid = { openApprovals };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(ExpenseRow, {
          row: parkedExpense,
          currency: "USD",
          onOpen: () => undefined,
        })
      );
    });

    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Review in Approvals"
    );
    expect(review).toBeDefined();
    await act(async () => review?.click());
    expect(openApprovals).toHaveBeenCalledOnce();
  });

  test("keeps expired Commons rows dismissible without offering an unsafe retry", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(ExpenseRow, {
          row: {
            ...parkedExpense,
            parked: false,
            intentStatus: "expired",
            pendingReason: "The 14-day review window ended.",
          },
          currency: "USD",
          onOpen: () => undefined,
          onDismiss: () => undefined,
          onRetry: () => undefined,
          onEditPending: () => undefined,
        })
      );
    });

    const labels = [...container.querySelectorAll("button")].map(
      (button) => button.textContent
    );
    expect(labels).toContain("Dismiss");
    expect(labels).not.toContain("Retry");
    expect(labels).not.toContain("Edit");
  });
});
