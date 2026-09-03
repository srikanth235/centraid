import type { MobileNotice } from "./gateway";

export type MobileNotificationsDestination =
  | { kind: "automation-thread"; automationRef: string }
  | { kind: "gateway-alerts" }
  | { kind: "outbox"; itemId: string }
  | { kind: "notifications" };

export function mobileNotificationsDestination(
  notice: MobileNotice
): MobileNotificationsDestination {
  if (notice.detail.sourceType === "automation") {
    const automationRef =
      typeof notice.detail.automationRef === "string"
        ? notice.detail.automationRef
        : notice.sourceRef;
    return { kind: "automation-thread", automationRef };
  }
  if (notice.detail.sourceType === "share") return { kind: "notifications" };
  if (notice.kind === "gateway-health") return { kind: "gateway-alerts" };
  if (notice.kind === "outbox") {
    const itemId =
      typeof notice.detail.itemId === "string"
        ? notice.detail.itemId
        : notice.sourceRef;
    return { kind: "outbox", itemId };
  }
  return { kind: "notifications" };
}
