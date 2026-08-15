import { describe, expect, test } from "vitest";

import type { MobileNotice } from "./gateway";
import { mobileNotificationsDestination } from "./notifications-navigation";

function notice(
  kind: string,
  sourceRef: string,
  detail: Record<string, unknown>
): MobileNotice {
  return {
    noticeId: `${kind}-1`,
    kind,
    sourceRef,
    headline: kind,
    detail,
    severity: "info",
    count: 1,
    firstAt: "2026-07-30T00:00:00.000Z",
    lastAt: "2026-07-30T00:00:00.000Z",
    readAt: null,
    archivedAt: null,
  };
}

describe(mobileNotificationsDestination, () => {
  test("routes every actionable notice to its exact native destination", () => {
    expect(
      mobileNotificationsDestination(
        notice("automation", "fallback/ref", {
          sourceType: "automation",
          automationRef: "daily/digest",
        })
      )
    ).toStrictEqual({
      kind: "automation-thread",
      automationRef: "daily/digest",
    });
    expect(
      mobileNotificationsDestination(
        notice("gateway-health", "gateway", { sourceType: "app" })
      )
    ).toStrictEqual({ kind: "gateway-alerts" });
    expect(
      mobileNotificationsDestination(
        notice("outbox", "fallback-item", {
          sourceType: "agent",
          itemId: "item-1",
        })
      )
    ).toStrictEqual({ kind: "outbox", itemId: "item-1" });
    // An app-scoped notice has no per-app screen to open since #799 retired
    // the WebView cover — it stays on the notice list rather than guessing.
    expect(
      mobileNotificationsDestination(
        notice("app", "tasks", { sourceType: "app", appId: "tasks" })
      )
    ).toStrictEqual({ kind: "notifications" });
  });
});
