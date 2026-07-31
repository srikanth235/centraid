import { describe, expect, test } from "vitest";

import {
  composeMobileNotifications,
  planNotifications,
} from "./notifications-plan";
import type { MobileNotificationsPull } from "./notifications-plan";

function pull(
  attentionAt = "2026-07-30T10:00:00.000Z"
): MobileNotificationsPull {
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

describe(composeMobileNotifications, () => {
  test("composes all decisions and only unread high notices", () => {
    expect(composeMobileNotifications(pull(), new Set())).toHaveLength(5);
  });

  test("dedupes an open decision but not a later re-created episode", () => {
    const first = pull();
    const delivered = new Set(
      composeMobileNotifications(first, new Set()).map((row) => row.key)
    );
    const recreated = pull("2026-07-31T10:00:00.000Z");
    const rows = composeMobileNotifications(recreated, delivered);

    expect(rows.map((row) => row.key)).toStrictEqual([
      "outbox:out-1:2026-07-31T10:00:00.000Z",
      "auth:conn-1:2026-07-31T10:00:00.000Z",
      "notice:notice-1:2026-07-31T10:00:00.000Z",
    ]);
  });
});

function quiet(): MobileNotificationsPull {
  return {
    decisions: { outbox: [], needsAuth: [], parked: [], scopeRequests: [] },
    notices: [],
  };
}

describe(planNotifications, () => {
  test("the first sync seeds the baseline silently instead of blasting", () => {
    const plan = planNotifications({
      notifications: pull(),
      delivered: [],
      seeded: false,
      appActive: false,
    });

    expect(plan.notifications).toStrictEqual([]);
    expect(plan.seeded).toBe(true);
    expect(plan.nextDelivered).toHaveLength(5);
  });

  test("a decision arriving after the seed still notifies", () => {
    const seed = planNotifications({
      notifications: pull(),
      delivered: [],
      seeded: false,
      appActive: false,
    });
    const plan = planNotifications({
      notifications: pull("2026-07-31T10:00:00.000Z"),
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

  test("a quiet Notifications seeds too, so the first real decision is news", () => {
    const seed = planNotifications({
      notifications: quiet(),
      delivered: [],
      seeded: false,
      appActive: false,
    });
    expect(seed.seeded).toBe(true);
    expect(seed.nextDelivered).toStrictEqual([]);

    const plan = planNotifications({
      notifications: pull(),
      delivered: seed.nextDelivered ?? [],
      seeded: true,
      appActive: false,
    });
    expect(plan.notifications).toHaveLength(5);
  });

  test("foreground composes nothing and leaves the ledger untouched", () => {
    const plan = planNotifications({
      notifications: pull(),
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
    const seed = planNotifications({
      notifications: pull(),
      delivered: [],
      seeded: false,
      appActive: false,
    });
    const plan = planNotifications({
      notifications: pull(),
      delivered: seed.nextDelivered ?? [],
      seeded: true,
      appActive: false,
    });

    expect(plan.notifications).toStrictEqual([]);
    expect(plan.nextDelivered).toBeUndefined();
  });
});
