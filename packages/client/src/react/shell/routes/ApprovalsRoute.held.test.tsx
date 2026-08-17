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
const listEnrichEgressConsent = vi
  .fn<VaultModule["listEnrichEgressConsent"]>()
  .mockResolvedValue([]);
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
  listEnrichEgressConsent: () => listEnrichEgressConsent(),
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
    openCommandPalette: vi.fn<ShellActions["openCommandPalette"]>(),
    openContextMenu: vi.fn<ShellActions["openContextMenu"]>(),
    confirm,
    navigate,
  };
}

describe("ApprovalsRoute held tray and write-back", () => {
  beforeEach(async () => {
    ({ default: ApprovalsRoute } = await import("./ApprovalsRoute.js"));
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

  it("says an old gateway cannot be asked about egress, and draws the rest", async () => {
    listEnrichEgressConsent.mockRejectedValueOnce(new Error("404"));
    const el = await render();
    expect(el.textContent).toContain(
      "This gateway is older than the consent ledger"
    );
    // One unreadable ledger never fails the page.
    expect(el.textContent).toContain("Nothing is waiting on you");
  });

  it("puts a refused write back, in the gateway's own words", async () => {
    getNotifications.mockResolvedValue({
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
            artifact: { to: "ravi@example.com", subject: "Hi", body: "Six." },
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
    } as unknown as Awaited<ReturnType<OutboxModule["getNotifications"]>>);
    decideOutboxItem.mockRejectedValue(
      new Error("repo.comment: GitHub token expired")
    );
    const el = await render();
    const findButton = (text: string): HTMLButtonElement =>
      [...el.querySelectorAll("button")].find(
        (b) => b.textContent === text
      ) as HTMLButtonElement;
    await act(async () => {
      findButton("Review").click();
    });
    await act(async () => {
      findButton("Approve").click();
      await Promise.resolve();
    });
    expect(el.textContent).toContain("The gateway refused that approval");
    expect(el.textContent).toContain("repo.comment: GitHub token expired");
    expect(
      el.querySelector<HTMLElement>('[data-testid="staged-write"]')?.dataset
        .itemId
    ).toBe("item1");
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
    let ring = (): void => undefined;
    subscribeNotificationsChanges.mockImplementation(async (onChange) => {
      ring = onChange;
    });

    const el = await render();
    await act(async () => {
      [...el.querySelectorAll("button")]
        .find((b) => b.textContent === "Review")!
        .click();
    });
    await act(async () => {
      [...el.querySelectorAll("button")]
        .find((b) => b.textContent === "Edit and approve")!
        .click();
    });
    expect(el.querySelector('input[aria-label="Subject"]')).not.toBeNull();

    await act(async () => {
      ring();
      await Promise.resolve();
    });
    expect(el.textContent).not.toContain("Loading Notifications…");
    expect(el.querySelector('input[aria-label="Subject"]')).not.toBeNull();
    expect(getNotifications).toHaveBeenCalledTimes(2);
  });
});
