import type { MobileNotice } from "./gateway";

export type MobileNotificationsDestination =
  | { kind: "automation-thread"; automationRef: string }
  | { kind: "gateway-alerts" }
  | { kind: "outbox"; itemId: string }
  | { kind: "notifications" };

/** Resolve a notice to the native surface where the owner can act on it. */
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
  if (notice.kind === "gateway-health") return { kind: "gateway-alerts" };
  if (notice.kind === "outbox") {
    const itemId =
      typeof notice.detail.itemId === "string"
        ? notice.detail.itemId
        : notice.sourceRef;
    return { kind: "outbox", itemId };
  }
  // An app-scoped notice has no destination of its own: every app is a native
  // cover reached from Home, and there is no generic per-app screen left to
  // push (issue #799). The notice list is where the
  // owner reads it, so that is where the tap lands.
  return { kind: "notifications" };
}
