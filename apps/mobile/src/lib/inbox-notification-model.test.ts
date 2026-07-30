import { describe, expect, test } from "vitest";

import { composeMobileInboxNotifications } from "./inbox-notification-model";
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
