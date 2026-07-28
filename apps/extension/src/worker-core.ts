/**
 * Service-worker pure helpers (issue #545 C10) — approval badge text and
 * warm/message routing without chrome APIs.
 */

/** Badge text for pending approval count (empty when none, capped at 99). */
export function approvalBadgeText(count: number | undefined | null): string {
  if (!count || count <= 0) return "";
  return String(Math.min(count, 99));
}

/**
 * When pairing is missing or companion is locked the badge is cleared.
 * When the gateway is unreachable, show "!" only if still paired.
 */
export function approvalBadgeForState(input: {
  paired: boolean;
  locked: boolean;
  count?: number;
  unreachable?: boolean;
}): string {
  if (!input.paired || input.locked) return "";
  if (input.unreachable) return "!";
  return approvalBadgeText(input.count);
}

/** Whether a runtime message is a locker fill that must clear fill material. */
export function isLockerFillMessage(message: unknown): boolean {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { type?: string }).type === "locker:fill"
  );
}

/** Context-menu capture filter — only the quick-task id with a tab URL. */
export function shouldCaptureContextMenu(input: {
  menuItemId: string | number;
  tabUrl?: string;
  expectedId?: string;
}): boolean {
  const expected = input.expectedId ?? "centraid-quick-task";
  return (
    input.menuItemId === expected &&
    typeof input.tabUrl === "string" &&
    input.tabUrl.length > 0
  );
}
