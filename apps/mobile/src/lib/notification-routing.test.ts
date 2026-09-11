// A Notifications push lands by what it is ABOUT (#1015 R-NY-2): a decision
// opens Needs you, a notice opens Activity's alerts view. Both halves of a tap
// — the action plan and the url the linking table follows — are pinned, so
// they cannot disagree.

import { describe, expect, test } from "vitest";

import {
  ALERTS_CATEGORY,
  NOTIFICATIONS_CATEGORY,
  notificationActionPlan,
  notificationsPushRouting,
} from "./notification-model";
import { composeMobileNotifications } from "./notifications-plan";

describe("a Notifications push", () => {
  test("a notice opens Activity's alerts view, not an empty Needs you", () => {
    const routing = notificationsPushRouting("notice");
    expect(routing.categoryIdentifier).toBe(ALERTS_CATEGORY);
    expect(routing.data.url).toBe("centraid://insights?initialTab=alerts");
    expect(notificationActionPlan("OPEN_ITEM", routing.data)).toStrictEqual({
      kind: "open-alerts",
    });
  });

  test("a decision still opens Needs you", () => {
    const routing = notificationsPushRouting("decision");
    expect(routing.categoryIdentifier).toBe(NOTIFICATIONS_CATEGORY);
    expect(routing.data.url).toBe("centraid://settings/notifications");
    expect(notificationActionPlan("OPEN_ITEM", routing.data)).toStrictEqual({
      kind: "open-notifications",
    });
  });

  test("every composed row knows which it is", () => {
    const rows = composeMobileNotifications(
      {
        decisions: {
          needsAuth: [
            {
              attentionAt: "2026-08-13T08:00:00.000Z",
              connectionId: "c-1",
              label: "Gmail",
            },
          ],
          outbox: [],
          parked: [{ command: "delete_files", invocationId: "i-1" }],
          scopeRequests: [{ appId: "brief", requestId: "r-1" }],
        },
        notices: [
          {
            archivedAt: null,
            headline: "Nightly digest did not finish",
            lastAt: "2026-08-13T08:00:00.000Z",
            noticeId: "n-1",
            readAt: null,
            severity: "high",
          },
        ],
      },
      new Set()
    );
    expect(rows.map((row) => [row.key.split(":")[0], row.about])).toStrictEqual(
      [
        ["auth", "decision"],
        ["parked", "decision"],
        ["scope", "decision"],
        ["notice", "notice"],
      ]
    );
  });
});
