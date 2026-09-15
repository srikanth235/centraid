/*
 * THE BADGE, AND WHAT A FRAME MEANS FOR IT (#1020 wave 4 lane extension,
 * D-1020-X4).
 *
 * v0's badge has one clock: a `chrome.alarms` entry at `periodInMinutes: 1`
 * (`apps/extension/src/worker.ts:85`–`:90`). MV3 evicts service workers
 * aggressively, so the alarm is the only thing that wakes the worker to ask
 * again — and an alarm's floor in Chrome is a minute, so the badge is up to a
 * minute stale by construction.
 *
 * The host can do better, because it holds a seat connection: when the seat's
 * state changes it pushes, and the worker draws. So (D-1020-X4):
 *
 * > **The badge is live while the port is open, and at most one minute
 * > otherwise.**
 *
 * The alarm is kept, not replaced. A push needs an open port and MV3 will close
 * one whenever it likes, so the alarm is what makes the contract's second half
 * true — and deleting it in favour of the better mechanism would have been the
 * classic trade of a bounded staleness for an unbounded one.
 *
 * The badge's own arithmetic is v0's, unchanged: empty when there is nothing,
 * capped at 99, `!` when the app is unreachable but this browser is still paired,
 * and empty when it is not paired at all.
 */

/** Badge text for a pending approval count (empty when none, capped at 99). */
export function approvalBadgeText(count: number | undefined | null): string {
  if (!count || count <= 0) return "";
  return String(Math.min(count, 99));
}

/**
 * The badge for a state.
 *
 * Carried from v0 (`worker-core.ts:14`–`:26`) including the rule that matters
 * most: when the app is unreachable the badge is `!` **only if this browser is
 * still paired**, because an unpaired browser showing an alarm is a browser
 * complaining about something the member never set up.
 */
export function approvalBadgeForState(input: {
  readonly paired: boolean;
  readonly locked: boolean;
  readonly count?: number;
  readonly unreachable?: boolean;
}): string {
  if (!input.paired || input.locked) return "";
  if (input.unreachable) return "!";
  return approvalBadgeText(input.count);
}

/** The badge's colour, by what it is saying. v0's two hexes. */
export function approvalBadgeColor(text: string): string {
  // The Watchtower warning is the red one; a pending count is the product blue.
  return text === "W" ? "#b42318" : "#315cf5";
}

/**
 * The count a host frame carries, or `undefined` when it carries none.
 *
 * Both the answer to `blocking-count` and an unsolicited push have the same
 * shape, which is deliberate: one reader, and a push cannot mean something the
 * poll does not.
 */
export function badgeCountOf(frame: unknown): number | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const shape = frame as { t?: unknown; value?: unknown; count?: unknown };
  const carrier = (
    shape.t === "ok" && shape.value && typeof shape.value === "object"
      ? shape.value
      : shape
  ) as { count?: unknown };
  return typeof carrier.count === "number" ? carrier.count : undefined;
}

/**
 * How stale the badge may be, as the sentence `extension/README.md` states.
 *
 * Exported so the README's claim and the code's behaviour cannot drift: the test
 * asserts the two numbers, and the alarm's period is the fallback's bound.
 */
export const BADGE_STALENESS = {
  /** Live: a push arrives as the seat's state changes. */
  whileConnected: 0,
  /** The alarm's floor in Chrome, and therefore the fallback's bound. */
  fallbackMs: 60_000,
} as const;

/** The alarm's name, and its period in minutes. v0's. */
export const APPROVAL_ALARM = "centraid-companion-approvals";
export const APPROVAL_ALARM_MINUTES = 1;

/** Whether a runtime message is a Locker fill, whose answer must be cleared. */
export function isLockerFillMessage(message: unknown): boolean {
  return (
    !!message &&
    typeof message === "object" &&
    ((message as { type?: string }).type === "locker:fill" ||
      (message as { verb?: string }).verb === "locker:fill")
  );
}

/** Context-menu capture filter — only the quick-task id with a tab URL. */
export function shouldCaptureContextMenu(input: {
  readonly menuItemId: string | number;
  readonly tabUrl?: string;
  readonly expectedId?: string;
}): boolean {
  const expected = input.expectedId ?? "centraid-quick-task";
  return (
    input.menuItemId === expected &&
    typeof input.tabUrl === "string" &&
    input.tabUrl.length > 0
  );
}

/** Build a page capture from tab / context-menu inputs. v0's fold. */
export function pageCaptureFromTab(input: {
  readonly title?: string;
  readonly url: string;
  readonly selectionText?: string;
}): { title: string; url: string; selection?: string } {
  return {
    title: input.title ?? input.url,
    url: input.url,
    ...(input.selectionText ? { selection: input.selectionText } : {}),
  };
}
