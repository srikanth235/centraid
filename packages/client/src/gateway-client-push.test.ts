import { describe, expect, test } from "vitest";

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
