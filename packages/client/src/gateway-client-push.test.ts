import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type * as TypeImport_core from "./gateway-client-core.js";
import type * as TypeImport_push from "./gateway-client-push.js";
import { composeWebInboxNotifications } from "./inbox-notification-model.js";
import type { InboxNotificationPull } from "./inbox-notification-model.js";

function pull(
  overrides: Partial<InboxNotificationPull["decisions"]> = {}
): InboxNotificationPull {
  return {
    decisions: {
      outbox: [],
      needsAuth: [],
      parked: [],
      scopeRequests: [],
      ...overrides,
    },
    notices: [],
  };
}

describe(composeWebInboxNotifications, () => {
  test("composes every decision kind and unread high notices locally", () => {
    const inbox = pull({
      outbox: [
        {
          itemId: "out-1",
          target: "mail",
          artifact: { subject: "Quarterly report" },
          stagedAt: "2026-07-30T10:00:00.000Z",
        },
      ],
      needsAuth: [
        {
          connectionId: "conn-1",
          label: "Gmail",
          attentionAt: "2026-07-30T10:01:00.000Z",
        },
      ],
      parked: [{ invocationId: "park-1", command: "calendar.create" }],
      scopeRequests: [{ requestId: "scope-1", appId: "brief" }],
    });
    inbox.notices.push(
      {
        noticeId: "notice-1",
        headline: "Gateway down",
        severity: "high",
        lastAt: "2026-07-30T10:02:00.000Z",
        readAt: null,
        archivedAt: null,
      },
      {
        noticeId: "notice-2",
        headline: "Quiet success",
        severity: "info",
        lastAt: "2026-07-30T10:03:00.000Z",
        readAt: null,
        archivedAt: null,
      }
    );

    expect(composeWebInboxNotifications(inbox, new Set())).toHaveLength(5);
    expect(
      composeWebInboxNotifications(
        inbox,
        new Set(["parked:park-1", "scope:scope-1"])
      ).map((row) => row.key)
    ).toStrictEqual([
      "outbox:out-1:2026-07-30T10:00:00.000Z",
      "auth:conn-1:2026-07-30T10:01:00.000Z",
      "notice:notice-1:2026-07-30T10:02:00.000Z",
    ]);
  });

  test("a re-created decision gets a new delivery key", () => {
    const first = pull({
      outbox: [
        {
          itemId: "out-1",
          target: "mail",
          artifact: {},
          stagedAt: "2026-07-30T10:00:00.000Z",
        },
      ],
      needsAuth: [
        {
          connectionId: "conn-1",
          label: "Gmail",
          attentionAt: "2026-07-30T10:00:00.000Z",
        },
      ],
    });
    const delivered = new Set(
      composeWebInboxNotifications(first, new Set()).map((row) => row.key)
    );
    const recreated = pull({
      outbox: [
        {
          ...first.decisions.outbox[0]!,
          stagedAt: "2026-07-31T10:00:00.000Z",
        },
      ],
      needsAuth: [
        {
          ...first.decisions.needsAuth[0]!,
          attentionAt: "2026-07-31T10:00:00.000Z",
        },
      ],
    });

    expect(
      composeWebInboxNotifications(recreated, delivered).map((row) => row.key)
    ).toStrictEqual([
      "outbox:out-1:2026-07-31T10:00:00.000Z",
      "auth:conn-1:2026-07-31T10:00:00.000Z",
    ]);
  });
});

// --- syncWebInboxNotifications -------------------------------------------
//
// The OS-banner half of the same surface. Two guards decide whether anything
// is shown at all, and both were missing (#647): a focused page must stay
// quiet, and the very first sync must take a silent baseline instead of
// firing one banner per already-open decision.

class FakeNotification extends EventTarget {
  static permission = "granted";
  static shown: string[] = [];
  constructor(title: string) {
    super();
    FakeNotification.shown.push(title);
  }
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

const STORAGE_KEY = `centraid:web-inbox:v1:${encodeURIComponent(
  "http://gateway.test vault-1"
)}`;

function ledger(): string[] {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === null ? [] : (JSON.parse(raw) as string[]);
}

function inboxPayload(itemIds: readonly string[]): InboxNotificationPull {
  return {
    decisions: {
      outbox: itemIds.map((itemId) => ({
        itemId,
        target: "mail",
        artifact: { subject: `Send ${itemId}` },
        stagedAt: "2026-07-30T10:00:00.000Z",
      })),
      needsAuth: [],
      parked: [],
      scopeRequests: [],
    },
    notices: [],
  };
}

describe("syncWebInboxNotifications", () => {
  let syncWebInboxNotifications: typeof TypeImport_push.syncWebInboxNotifications;
  let resetGatewayAuthCache: typeof TypeImport_core.resetGatewayAuthCache;
  const getGatewayAuth = vi.fn<typeof window.CentraidApi.getGatewayAuth>();
  const fetchMock = vi.fn<typeof fetch>();

  beforeAll(async () => {
    window.CentraidApi = {
      getGatewayAuth,
      onGatewayChanged: () => () => undefined,
      onVaultChanged: () => () => undefined,
    } as unknown as typeof window.CentraidApi;
    (globalThis as { Notification?: unknown }).Notification =
      FakeNotification as unknown as typeof Notification;
    ({ syncWebInboxNotifications } = await import("./gateway-client-push.js"));
    ({ resetGatewayAuthCache } = await import("./gateway-client-core.js"));
  });

  beforeEach(() => {
    window.localStorage.clear();
    FakeNotification.shown = [];
    setVisibility("hidden");
    getGatewayAuth.mockReset().mockResolvedValue({
      baseUrl: "http://gateway.test",
      gatewayId: "gateway-1",
      iroh: false,
      token: "device-token",
      vaultId: "vault-1",
    });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resetGatewayAuthCache();
  });

  function serve(payload: InboxNotificationPull): void {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }

  test("a visible page never composes — no fetch, no banners", async () => {
    setVisibility("visible");
    serve(inboxPayload(["out-1", "out-2"]));

    await syncWebInboxNotifications();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeNotification.shown).toStrictEqual([]);
  });

  test("the first sync seeds the ledger silently instead of blasting", async () => {
    serve(inboxPayload(["out-1", "out-2"]));

    await syncWebInboxNotifications();

    expect(FakeNotification.shown).toStrictEqual([]);
    expect(ledger()).toContain("outbox:out-1:2026-07-30T10:00:00.000Z");
    expect(ledger()).toContain("outbox:out-2:2026-07-30T10:00:00.000Z");
  });

  test("after the baseline, only a genuinely new decision notifies", async () => {
    serve(inboxPayload(["out-1"]));
    await syncWebInboxNotifications();
    expect(FakeNotification.shown).toStrictEqual([]);

    serve(inboxPayload(["out-1", "out-2"]));
    await syncWebInboxNotifications();

    expect(FakeNotification.shown).toStrictEqual(["Send out-2"]);
  });

  test("an empty first payload still counts as the baseline", async () => {
    serve(inboxPayload([]));
    await syncWebInboxNotifications();

    // Without the sentinel the empty ledger would re-arm seeding and swallow
    // this decision instead of notifying.
    serve(inboxPayload(["out-1"]));
    await syncWebInboxNotifications();

    expect(FakeNotification.shown).toStrictEqual(["Send out-1"]);
  });
});
