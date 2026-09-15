import { describe, expect, it } from "vitest";

import {
  APPROVAL_ALARM_MINUTES,
  approvalBadgeColor,
  approvalBadgeForState,
  approvalBadgeText,
  BADGE_STALENESS,
  badgeCountOf,
  isLockerFillMessage,
  pageCaptureFromTab,
  shouldCaptureContextMenu,
} from "./worker-core.js";

describe("the approval badge", () => {
  it("is empty, a number, or 99 at most", () => {
    expect(approvalBadgeText(0)).toBe("");
    expect(approvalBadgeText(undefined)).toBe("");
    expect(approvalBadgeText(-1)).toBe("");
    expect(approvalBadgeText(7)).toBe("7");
    expect(approvalBadgeText(4242)).toBe("99");
  });

  it("says nothing when this browser is not paired, even when unreachable", () => {
    expect(
      approvalBadgeForState({ paired: false, locked: false, unreachable: true })
    ).toBe("");
    expect(
      approvalBadgeForState({ paired: true, locked: true, count: 5 })
    ).toBe("");
    expect(
      approvalBadgeForState({ paired: true, locked: false, unreachable: true })
    ).toBe("!");
    expect(
      approvalBadgeForState({ paired: true, locked: false, count: 3 })
    ).toBe("3");
  });

  it("reads a count from a poll and a push the same way", () => {
    expect(badgeCountOf({ t: "ok", value: { count: 4 } })).toBe(4);
    expect(badgeCountOf({ t: "push", count: 4 })).toBe(4);
    expect(badgeCountOf({ t: "ok", value: {} })).toBeUndefined();
    expect(badgeCountOf(null)).toBeUndefined();
  });

  it("colours a warning differently from a count", () => {
    expect(approvalBadgeColor("W")).toBe("#b42318");
    expect(approvalBadgeColor("3")).toBe("#315cf5");
  });

  /*
   * THE STALENESS CONTRACT (D-1020-X4), asserted so `extension/README.md`'s
   * sentence and the code cannot drift: **live while connected, at most one
   * minute otherwise** — and the "otherwise" bound IS the alarm's period, which
   * is why the alarm is kept rather than replaced.
   */
  it("states the same staleness the README does", () => {
    expect(BADGE_STALENESS.whileConnected).toBe(0);
    expect(BADGE_STALENESS.fallbackMs).toBe(APPROVAL_ALARM_MINUTES * 60_000);
  });
});

describe("the worker's routing", () => {
  it("recognises a fill by either spelling", () => {
    expect(isLockerFillMessage({ type: "locker:fill" })).toBe(true);
    expect(isLockerFillMessage({ verb: "locker:fill" })).toBe(true);
    expect(isLockerFillMessage({ type: "locker:save" })).toBe(false);
    expect(isLockerFillMessage(undefined)).toBe(false);
  });

  it("captures only the quick-task menu item on a real tab", () => {
    expect(
      shouldCaptureContextMenu({
        menuItemId: "centraid-quick-task",
        tabUrl: "https://example.test",
      })
    ).toBe(true);
    expect(
      shouldCaptureContextMenu({ menuItemId: "centraid-quick-task" })
    ).toBe(false);
    expect(
      shouldCaptureContextMenu({
        menuItemId: "something-else",
        tabUrl: "https://example.test",
      })
    ).toBe(false);
  });

  it("falls back to the URL when a tab has no title", () => {
    expect(pageCaptureFromTab({ url: "https://example.test/a" })).toStrictEqual(
      {
        title: "https://example.test/a",
        url: "https://example.test/a",
      }
    );
    expect(
      pageCaptureFromTab({
        title: "A Page",
        url: "https://example.test/a",
        selectionText: "a sentence",
      })
    ).toStrictEqual({
      title: "A Page",
      url: "https://example.test/a",
      selection: "a sentence",
    });
  });
});
