import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellActions } from "../actions.js";
import type * as TypeImport_qcp7vy from "../actions.js";
import type * as TypeImport_1lvx9zk from "./ApprovalsRoute.js";

type OutboxModule = typeof import("../../../gateway-client-outbox.js");
type PushModule = typeof import("../../../gateway-client-push.js");
type VaultModule = typeof import("../../../gateway-client-vault.js");

const getNotifications = vi.fn<OutboxModule["getNotifications"]>();
const listOutboxGrants = vi.fn<OutboxModule["listOutboxGrants"]>();
const getReview = vi.fn<OutboxModule["getReview"]>();
const subscribeNotificationsChanges =
  vi.fn<OutboxModule["subscribeNotificationsChanges"]>();
const decideOutboxItem =
  vi.fn<(input: unknown) => ReturnType<OutboxModule["decideOutboxItem"]>>();
const enableWebPushWake = vi.fn<PushModule["enableWebPushWake"]>();
const syncWebNotifications = vi.fn<PushModule["syncWebNotifications"]>();
vi.mock(import("../../../gateway-client-outbox.js"), () => ({
  getNotifications: (includeArchived?: boolean) =>
    getNotifications(includeArchived),
  listOutboxGrants: () => listOutboxGrants(),
  getReview: () => getReview(),
  subscribeNotificationsChanges: (onChange: () => void, signal?: AbortSignal) =>
    subscribeNotificationsChanges(onChange, signal),
  updateNotice: vi.fn<OutboxModule["updateNotice"]>(),
  decideOutboxItem: (input: unknown) => decideOutboxItem(input),
  decideScopeRequest: vi.fn<OutboxModule["decideScopeRequest"]>(),
  revokeOutboxGrant: vi.fn<OutboxModule["revokeOutboxGrant"]>(),
}));
const vaultApps = vi.fn<VaultModule["vaultApps"]>().mockResolvedValue([]);
const listAgents = vi.fn<VaultModule["listAgents"]>().mockResolvedValue([]);
vi.mock(import("../../../gateway-client-vault.js"), () => ({
  confirmVaultParked: vi.fn<VaultModule["confirmVaultParked"]>(),
  vaultApps: () => vaultApps(),
  listAgents: () => listAgents(),
  revokeVaultGrant: vi.fn<VaultModule["revokeVaultGrant"]>(),
}));
vi.mock(import("../../../gateway-client-push.js"), () => ({
  enableWebPushWake: (requestPermission: boolean) =>
    enableWebPushWake(requestPermission),
  syncWebNotifications: () => syncWebNotifications(),
}));

let ApprovalsRoute: typeof TypeImport_1lvx9zk.default;
let ShellActionsProvider: typeof TypeImport_qcp7vy.ShellActionsProvider;
let root: Root | null = null;
let host: HTMLElement | null = null;

const confirm = vi.fn<ShellActions["confirm"]>().mockResolvedValue(true);
const showToast = vi.fn<ShellActions["showToast"]>();
const navigate = vi.fn<ShellActions["navigate"]>();

function makeActions(): ShellActions {
  return {
    showToast,
    builderEnabled: false,
    enterBuilder: vi.fn<ShellActions["enterBuilder"]>(),
    openNewAppSheet: vi.fn<ShellActions["openNewAppSheet"]>(),
    openCommandPalette: vi.fn<ShellActions["openCommandPalette"]>(),
    openContextMenu: vi.fn<ShellActions["openContextMenu"]>(),
    confirm,
    navigate,
  };
}

describe("ApprovalsRoute", () => {
  beforeEach(async () => {
    ({ default: ApprovalsRoute } = await import("./ApprovalsRoute.js"));
    // The route's data lives in the shell's shared stale-while-revalidate
    // cache (issue #659), which deliberately outlives a mount — so each case
    // starts from the same empty cache a fresh vault would give it.
    (await import("../queryCache.js")).resetQueryCache();
    ({ ShellActionsProvider } = await import("../actions.js"));
    getNotifications.mockReset().mockResolvedValue({
      decisions: {
        outbox: [],
        needsAuth: [],
        parked: [],
        scopeRequests: [],
        count: 0,
      },
      notices: [],
      unreadNoticeCount: 0,
    });
    subscribeNotificationsChanges.mockReset().mockResolvedValue(undefined);
    listOutboxGrants.mockReset().mockResolvedValue([]);
    getReview.mockReset().mockResolvedValue([]);
    decideOutboxItem.mockReset();
    enableWebPushWake.mockReset().mockResolvedValue(false);
    syncWebNotifications.mockReset().mockResolvedValue(undefined);
    confirm.mockClear().mockResolvedValue(true);
    showToast.mockClear();
    navigate.mockClear();
  });

  async function render(): Promise<HTMLElement> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ShellActionsProvider value={makeActions()}>
          <ApprovalsRoute />
        </ShellActionsProvider>
      );
    });
    return host;
  }

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  describe("ApprovalsRoute", () => {
    it("shows a loading state, then the empty state once the blocking notifications resolves empty", async () => {
      const el = await render();
      expect(el.textContent).toContain("Nothing waiting on you.");
      expect(enableWebPushWake).toHaveBeenCalledWith(true);
    });

    it("surfaces a fetch error", async () => {
      getNotifications.mockRejectedValue(new Error("offline"));
      const el = await render();
      expect(el.querySelector(".pageEmpty")?.textContent).toContain("offline");
    });

    it("opens Connectors from a needs-auth decision", async () => {
      getNotifications.mockResolvedValue({
        decisions: {
          outbox: [],
          needsAuth: [
            {
              connectionId: "conn-1",
              kind: "pull.gmail",
              label: "personal",
              note: "token expired",
              attentionAt: "2026-07-30T10:00:00.000Z",
            },
          ],
          parked: [],
          scopeRequests: [],
          count: 1,
        },
        notices: [],
        unreadNoticeCount: 0,
      });
      const el = await render();
      const reconnect = [...el.querySelectorAll("button")].find(
        (button) => button.textContent === "Reconnect"
      );
      expect(reconnect).toBeDefined();
      act(() => reconnect?.click());
      expect(navigate).toHaveBeenCalledWith({ kind: "connectors" });
    });

    it("approves an outbox item and reloads the notifications", async () => {
      getNotifications.mockResolvedValueOnce({
        decisions: {
          outbox: [
            {
              itemId: "item1",
              connection: { kind: "pull.gmail", label: "personal" },
              actor: "gmail-send",
              actorId: "agent-1",
              actorKind: "ai_agent",
              verb: "gmail.send",
              target: "ravi@example.com",
              artifact: {
                to: "ravi@example.com",
                subject: "Hi",
                body: "See you at 6.",
              },
              status: "pending",
              grantId: null,
              stagedAt: new Date().toISOString(),
              decidedAt: null,
              drainedAt: null,
              result: null,
              note: null,
              canEdit: false,
            },
          ],
          needsAuth: [],
          parked: [],
          scopeRequests: [],
          count: 1,
        },
        notices: [],
        unreadNoticeCount: 0,
      });
      getNotifications.mockResolvedValueOnce({
        decisions: {
          outbox: [],
          needsAuth: [],
          parked: [],
          scopeRequests: [],
          count: 0,
        },
        notices: [],
        unreadNoticeCount: 0,
      });
      decideOutboxItem.mockResolvedValue({
        status: "executed",
        invocationId: "inv1",
        receiptId: "rec1",
        output: { item_id: "item1", status: "approved" },
      });
      const el = await render();
      const subjectBtn = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Hi")
      ) as HTMLButtonElement;
      await act(async () => subjectBtn.click());
      const approveBtn = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Approve"
      ) as HTMLButtonElement;
      await act(async () => {
        approveBtn.click();
        await Promise.resolve();
      });
      expect(decideOutboxItem).toHaveBeenCalledWith({
        itemId: "item1",
        decision: "approve",
        alwaysAllow: false,
      });
      expect(getNotifications).toHaveBeenCalledTimes(2);
    });

    it("edits an editable outbox item and approves with the revised artifact", async () => {
      getNotifications.mockResolvedValueOnce({
        decisions: {
          outbox: [
            {
              itemId: "item1",
              connection: { kind: "pull.gmail", label: "personal" },
              actor: "gmail-send",
              actorId: "agent-1",
              actorKind: "ai_agent",
              verb: "gmail.send",
              target: "ravi@example.com",
              artifact: {
                to: "ravi@example.com",
                subject: "Hi",
                body: "See you at 6.",
              },
              status: "pending",
              grantId: null,
              stagedAt: new Date().toISOString(),
              decidedAt: null,
              drainedAt: null,
              result: null,
              note: null,
              canEdit: true,
            },
          ],
          needsAuth: [],
          parked: [],
          scopeRequests: [],
          count: 1,
        },
        notices: [],
        unreadNoticeCount: 0,
      });
      getNotifications.mockResolvedValueOnce({
        decisions: {
          outbox: [],
          needsAuth: [],
          parked: [],
          scopeRequests: [],
          count: 0,
        },
        notices: [],
        unreadNoticeCount: 0,
      });
      decideOutboxItem.mockResolvedValue({
        status: "executed",
        invocationId: "inv1",
        receiptId: "rec1",
        output: { item_id: "item1", status: "approved" },
      });
      const el = await render();
      const findButton = (text: string): HTMLButtonElement =>
        [...el.querySelectorAll("button")].find(
          (b) => b.textContent === text
        ) as HTMLButtonElement;
      await act(async () => {
        [...el.querySelectorAll("button")]
          .find((b) => b.textContent?.includes("Hi"))!
          .click();
      });
      await act(async () => {
        findButton("Edit").click();
      });
      const subjectInput = el.querySelector(
        'input[aria-label="Subject"]'
      ) as HTMLInputElement;
      const setNativeValue = (input: HTMLInputElement, value: string): void => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => {
        setNativeValue(subjectInput, "Edited subject");
      });
      await act(async () => {
        findButton("Approve with edits").click();
        await Promise.resolve();
      });
      expect(decideOutboxItem).toHaveBeenCalledWith({
        itemId: "item1",
        decision: "approve",
        alwaysAllow: false,
        artifact: {
          to: "ravi@example.com",
          subject: "Edited subject",
          body: "See you at 6.",
        },
      });
      expect(getNotifications).toHaveBeenCalledTimes(2);
    });

    it("opens each notice at its exact action surface", async () => {
      const at = "2026-07-30T10:00:00.000Z";
      getNotifications.mockResolvedValue({
        decisions: {
          // The outbox notice below points at this still-open item, so its
          // deep link has somewhere real to land (#647 D10).
          outbox: [
            {
              itemId: "item-1",
              connection: { kind: "pull.gmail", label: "personal" },
              actor: "gmail-send",
              actorId: "agent-1",
              actorKind: "ai_agent",
              verb: "gmail.send",
              target: "ravi@example.com",
              artifact: {
                to: "ravi@example.com",
                subject: "Hi",
                body: "See you at 6.",
              },
              status: "pending",
              grantId: null,
              stagedAt: at,
              decidedAt: null,
              drainedAt: null,
              result: null,
              note: null,
              canEdit: false,
            },
          ],
          needsAuth: [],
          parked: [],
          scopeRequests: [],
          count: 1,
        },
        notices: [
          {
            noticeId: "automation-notice",
            kind: "automation",
            sourceRef: "daily/digest",
            headline: "Digest finished",
            detail: {
              sourceType: "automation",
              automationRef: "daily/digest",
            },
            severity: "info",
            count: 1,
            firstAt: at,
            lastAt: at,
            readAt: null,
            archivedAt: null,
          },
          {
            noticeId: "gateway-notice",
            kind: "gateway-health",
            sourceRef: "gateway-1",
            headline: "Gateway degraded",
            detail: { sourceType: "app" },
            severity: "high",
            count: 1,
            firstAt: at,
            lastAt: at,
            readAt: null,
            archivedAt: null,
          },
          {
            noticeId: "app-notice",
            kind: "app",
            sourceRef: "tasks",
            headline: "Tasks imported",
            detail: { sourceType: "app", appId: "tasks" },
            severity: "info",
            count: 1,
            firstAt: at,
            lastAt: at,
            readAt: null,
            archivedAt: null,
          },
          {
            noticeId: "outbox-notice",
            kind: "outbox",
            sourceRef: "item-1",
            headline: "Message needs approval again",
            detail: { sourceType: "agent", itemId: "item-1" },
            severity: "warning",
            count: 1,
            firstAt: at,
            lastAt: at,
            readAt: null,
            archivedAt: null,
          },
        ],
        unreadNoticeCount: 4,
      });
      const el = await render();
      const clickHeadline = (headline: string): void => {
        const button = [...el.querySelectorAll("button")].find((candidate) =>
          candidate.textContent?.includes(headline)
        );
        expect(button).toBeDefined();
        act(() => button?.click());
      };

      // Info-severity notices sit under their source chip, not "Needs me"
      // (#665) — the deep links still work from there.
      clickHeadline("Automations");
      clickHeadline("Digest finished");
      expect(navigate).toHaveBeenLastCalledWith({
        kind: "automation-view",
        automationId: "daily/digest",
      });
      clickHeadline("Needs me");
      clickHeadline("Gateway degraded");
      expect(navigate).toHaveBeenLastCalledWith({
        kind: "gateway",
        tab: "alerts",
      });
      clickHeadline("Apps");
      clickHeadline("Tasks imported");
      expect(navigate).toHaveBeenLastCalledWith({ kind: "app", id: "tasks" });
      clickHeadline("Needs me");
      // An outbox notice must NOT self-navigate to the page we are already
      // on — it puts the staged decision it names in front of the owner.
      const navigationsBefore = navigate.mock.calls.length;
      clickHeadline("Message needs approval again");
      expect(navigate).toHaveBeenCalledTimes(navigationsBefore);
      expect(
        (
          el.querySelector(
            '[data-testid="outbox-row-item-1"]'
          ) as HTMLElement | null
        )?.dataset.focused
      ).toBe("true");
      expect(el.textContent).toContain("See you at 6.");
    });

    it("keeps the screen mounted across an SSE doorbell refetch", async () => {
      const item = (subject: string): Record<string, unknown> => ({
        itemId: "item1",
        connection: { kind: "pull.gmail", label: "personal" },
        actor: "gmail-send",
        actorId: "agent-1",
        actorKind: "ai_agent",
        verb: "gmail.send",
        target: "ravi@example.com",
        artifact: { to: "ravi@example.com", subject, body: "See you at 6." },
        status: "pending",
        grantId: null,
        stagedAt: "2026-07-30T10:00:00.000Z",
        decidedAt: null,
        drainedAt: null,
        result: null,
        note: null,
        canEdit: true,
      });
      const notificationsWith = (
        subject: string
      ): Awaited<ReturnType<OutboxModule["getNotifications"]>> =>
        ({
          decisions: {
            outbox: [item(subject)],
            needsAuth: [],
            parked: [],
            scopeRequests: [],
            count: 1,
          },
          notices: [],
          unreadNoticeCount: 0,
        }) as unknown as Awaited<ReturnType<OutboxModule["getNotifications"]>>;
      getNotifications.mockResolvedValue(notificationsWith("Hi"));
      // Capture the doorbell the route hands to the SSE subscription.
      let ring = (): void => undefined;
      subscribeNotificationsChanges.mockImplementation(async (onChange) => {
        ring = onChange;
      });

      const el = await render();
      // Put the owner mid-flight: row expanded, edit form open.
      await act(async () => {
        [...el.querySelectorAll("button")]
          .find((b) => b.textContent?.includes("Hi"))!
          .click();
      });
      await act(async () => {
        [...el.querySelectorAll("button")]
          .find((b) => b.textContent === "Edit")!
          .click();
      });
      expect(el.querySelector('input[aria-label="Subject"]')).not.toBeNull();

      // A doorbell must refresh the data underneath, not tear the screen down
      // and throw the half-finished edit away.
      await act(async () => {
        ring();
        await Promise.resolve();
      });
      expect(el.textContent).not.toContain("Loading Notifications…");
      expect(el.querySelector('input[aria-label="Subject"]')).not.toBeNull();
      expect(getNotifications).toHaveBeenCalledTimes(2);
    });
  });
});
