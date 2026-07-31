import { describe, expect, test } from "vitest";

import type { MobileInboxNotice } from "./gateway";
import { mobileInboxDestination } from "./inbox-navigation";

function notice(
  kind: string,
  sourceRef: string,
  detail: Record<string, unknown>
): MobileInboxNotice {
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

describe(mobileInboxDestination, () => {
  test("routes every actionable notice to its exact native destination", () => {
    expect(
      mobileInboxDestination(
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
      mobileInboxDestination(
        notice("gateway-health", "gateway", { sourceType: "app" })
      )
    ).toStrictEqual({ kind: "gateway-alerts" });
    expect(
      mobileInboxDestination(
        notice("outbox", "fallback-item", {
          sourceType: "agent",
          itemId: "item-1",
        })
      )
    ).toStrictEqual({ kind: "outbox", itemId: "item-1" });
    expect(
      mobileInboxDestination(
        notice("app", "tasks", { sourceType: "app", appId: "tasks" })
      )
    ).toStrictEqual({ kind: "app", appId: "tasks" });
  });
});
