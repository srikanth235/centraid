// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PENDING_OVERLAY_FIELDS } from "./pending-overlay.ts";
import { PendingWriteActions } from "./PendingWriteActions.tsx";

describe(PendingWriteActions, () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  test("parked rows navigate to the shell-owned Approvals inbox", async () => {
    const openApprovals = vi.fn<() => void>();
    (window as unknown as { centraid: unknown }).centraid = { openApprovals };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(PendingWriteActions, {
          row: {
            [PENDING_OVERLAY_FIELDS.key]: "intent-parked",
            [PENDING_OVERLAY_FIELDS.action]: "add",
            [PENDING_OVERLAY_FIELDS.status]: "parked",
            [PENDING_OVERLAY_FIELDS.reason]: "Owner review required.",
          },
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

  test("an attempted write that is still queued says how long it has waited", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const queued = {
      [PENDING_OVERLAY_FIELDS.key]: "intent-stuck",
      [PENDING_OVERLAY_FIELDS.action]: "rename",
      [PENDING_OVERLAY_FIELDS.status]: "queued",
      [PENDING_OVERLAY_FIELDS.enqueuedAt]: new Date(
        Date.now() - 12 * 60_000
      ).toISOString(),
    };
    await act(async () => {
      root?.render(
        createElement(PendingWriteActions, {
          row: { ...queued, [PENDING_OVERLAY_FIELDS.attempts]: 3 },
        })
      );
    });
    expect(container.textContent).toContain("Queued 12m ago");

    // Never attempted is offline, not stuck: the chip already says so.
    await act(async () => {
      root?.render(
        createElement(PendingWriteActions, {
          row: { ...queued, [PENDING_OVERLAY_FIELDS.attempts]: 0 },
        })
      );
    });
    expect(container.textContent).not.toContain("Queued");
  });

  test("conflicts retain version detail plus edit, retry, and discard", async () => {
    const retryPendingWrite = vi.fn<() => Promise<boolean>>(() =>
      Promise.resolve(true)
    );
    const discardPendingWrite = vi.fn<() => Promise<boolean>>(() =>
      Promise.resolve(true)
    );
    const onEdit = vi.fn<() => void>();
    (window as unknown as { centraid: unknown }).centraid = {
      retryPendingWrite,
      discardPendingWrite,
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(PendingWriteActions, {
          row: {
            [PENDING_OVERLAY_FIELDS.key]: "intent-conflict",
            [PENDING_OVERLAY_FIELDS.action]: "edit",
            [PENDING_OVERLAY_FIELDS.status]: "conflict",
            [PENDING_OVERLAY_FIELDS.reason]: "Row changed.",
            [PENDING_OVERLAY_FIELDS.expectedVersion]: 4,
            [PENDING_OVERLAY_FIELDS.actualVersion]: 5,
            __centraidScopeId: "family-vault",
          },
          onEdit,
        })
      );
    });

    expect(container.textContent).toContain("Expected version 4; found 5.");
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toStrictEqual([
      "Edit",
      "Retry",
      "Discard",
    ]);
    await act(async () => {
      buttons[0]?.click();
      buttons[1]?.click();
      buttons[2]?.click();
    });
    expect(onEdit).toHaveBeenCalledOnce();
    expect(retryPendingWrite).toHaveBeenCalledWith(
      "intent-conflict",
      "family-vault"
    );
    expect(discardPendingWrite).toHaveBeenCalledWith(
      "intent-conflict",
      "family-vault"
    );
  });
});
