import { describe, expect, test } from "vitest";

import {
  composeMobileInboxNotifications,
  planInboxNotifications,
} from "./inbox-notification-model";
import type { MobileInboxNotificationPull } from "./inbox-notification-model";

function pull(
  attentionAt = "2026-07-30T10:00:00.000Z"
): MobileInboxNotificationPull {
  return {
    decisions: {
      outbox: [
        {
          itemId: "out-1",
          target: "mail",
          artifact: { subject: "Quarterly report" },
          stagedAt: attentionAt,
        },
      ],
      needsAuth: [
        {
          connectionId: "conn-1",
          label: "Gmail",
          attentionAt,
        },
      ],
      parked: [{ invocationId: "park-1", command: "calendar.create" }],
      scopeRequests: [{ requestId: "scope-1", appId: "brief" }],
    },
    notices: [
      {
        noticeId: "notice-1",
        headline: "Gateway down",
        severity: "high",
        lastAt: attentionAt,
        readAt: null,
        archivedAt: null,
      },
      {
        noticeId: "notice-2",
        headline: "Quiet success",
        severity: "info",
        lastAt: attentionAt,
        readAt: null,
        archivedAt: null,
      },
    ],
  };
}

describe(composeMobileInboxNotifications, () => {
  test("composes all decisions and only unread high notices", () => {
    expect(composeMobileInboxNotifications(pull(), new Set())).toHaveLength(5);
  });

  test("dedupes an open decision but not a later re-created episode", () => {
    const first = pull();
    const delivered = new Set(
      composeMobileInboxNotifications(first, new Set()).map((row) => row.key)
    );
    const recreated = pull("2026-07-31T10:00:00.000Z");
    const rows = composeMobileInboxNotifications(recreated, delivered);

    expect(rows.map((row) => row.key)).toStrictEqual([
      "outbox:out-1:2026-07-31T10:00:00.000Z",
      "auth:conn-1:2026-07-31T10:00:00.000Z",
      "notice:notice-1:2026-07-31T10:00:00.000Z",
    ]);
  });
});

function quiet(): MobileInboxNotificationPull {
  return {
    decisions: { outbox: [], needsAuth: [], parked: [], scopeRequests: [] },
    notices: [],
  };
}

describe(planInboxNotifications, () => {
  test("the first sync seeds the baseline silently instead of blasting", () => {
    const plan = planInboxNotifications({
      inbox: pull(),
      delivered: [],
      seeded: false,
      appActive: false,
    });

    expect(plan.notifications).toStrictEqual([]);
    expect(plan.seeded).toBe(true);
    expect(plan.nextDelivered).toHaveLength(5);
  });

  test("a decision arriving after the seed still notifies", () => {
    const seed = planInboxNotifications({
      inbox: pull(),
      delivered: [],
      seeded: false,
      appActive: false,
    });
    const plan = planInboxNotifications({
      inbox: pull("2026-07-31T10:00:00.000Z"),
      delivered: seed.nextDelivered ?? [],
      seeded: true,
      appActive: false,
    });

    expect(plan.notifications.map((row) => row.key)).toStrictEqual([
      "outbox:out-1:2026-07-31T10:00:00.000Z",
      "auth:conn-1:2026-07-31T10:00:00.000Z",
      "notice:notice-1:2026-07-31T10:00:00.000Z",
    ]);
  });

  test("a quiet Inbox seeds too, so the first real decision is news", () => {
    const seed = planInboxNotifications({
      inbox: quiet(),
      delivered: [],
      seeded: false,
      appActive: false,
    });
    expect(seed.seeded).toBe(true);
    expect(seed.nextDelivered).toStrictEqual([]);

    const plan = planInboxNotifications({
      inbox: pull(),
      delivered: seed.nextDelivered ?? [],
      seeded: true,
      appActive: false,
    });
    expect(plan.notifications).toHaveLength(5);
  });

  test("foreground composes nothing and leaves the ledger untouched", () => {
    const plan = planInboxNotifications({
      inbox: pull(),
      delivered: ["outbox:out-1:2026-07-30T10:00:00.000Z"],
      seeded: true,
      appActive: true,
    });

    expect(plan.notifications).toStrictEqual([]);
    // Untouched, not overwritten: a decision the owner did not act on while
    // looking must still notify on the next background wake.
    expect(plan.nextDelivered).toBeUndefined();
    expect(plan.seeded).toBe(false);
  });

  test("a background pass with nothing new writes no ledger", () => {
    const seed = planInboxNotifications({
      inbox: pull(),
      delivered: [],
      seeded: false,
      appActive: false,
    });
    const plan = planInboxNotifications({
      inbox: pull(),
      delivered: seed.nextDelivered ?? [],
      seeded: true,
      appActive: false,
    });

    expect(plan.notifications).toStrictEqual([]);
    expect(plan.nextDelivered).toBeUndefined();
  });
});
