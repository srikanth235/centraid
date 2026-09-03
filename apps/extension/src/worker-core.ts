export function approvalBadgeText(count: number | undefined | null): string {
  if (!count || count <= 0) return "";
  return String(Math.min(count, 99));
}

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

export function isLockerFillMessage(message: unknown): boolean {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { type?: string }).type === "locker:fill"
  );
}

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
