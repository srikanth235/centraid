// Quick add's projection (§3). The When chips are the only place a date is
// derived from a word, so this suite pins each one against a known Friday —
// and pins that the field itself never contributes one.
import { describe, expect, it } from "vitest";

import {
  QUICK_ADD_EMPTY,
  quickAddDue,
  quickAddFiling,
  quickAddInput,
  quickAddLandsIn,
  quickAddReady,
} from "./quick-add.ts";
import { GROUPS } from "./view-copy.ts";

// A Friday, so "this weekend" is still ahead and "next week" clears it.
const FRIDAY = "2026-08-28T09:00:00Z";
const SATURDAY = "2026-08-29T09:00:00Z";
const SUNDAY = "2026-08-30T09:00:00Z";

describe("the When chips", () => {
  it("names the day each chip means", () => {
    expect(quickAddDue("today", FRIDAY)).toBe("2026-08-28");
    expect(quickAddDue("tomorrow", FRIDAY)).toBe("2026-08-29");
    expect(quickAddDue("weekend", FRIDAY)).toBe("2026-08-29");
    expect(quickAddDue("next-week", FRIDAY)).toBe("2026-08-31");
  });

  it("keeps a weekend that has already arrived as today", () => {
    expect(quickAddDue("weekend", SATURDAY)).toBe("2026-08-29");
    expect(quickAddDue("weekend", SUNDAY)).toBe("2026-08-30");
  });

  it("takes Sunday's next week to the very next day", () => {
    expect(quickAddDue("next-week", SUNDAY)).toBe("2026-08-31");
  });

  it("treats No date as a choice, not as a missing answer", () => {
    expect(quickAddDue("none", FRIDAY)).toBeNull();
  });
});

describe("what quick add writes", () => {
  const draft = { ...QUICK_ADD_EMPTY, title: "  Rinse the filter  " };

  it("writes a bare title and nothing it was never given", () => {
    expect(quickAddInput(draft, FRIDAY)).toStrictEqual({
      title: "Rinse the filter",
    });
  });

  it("carries a chosen date and a set priority, and only those", () => {
    expect(
      quickAddInput({ ...draft, when: "today", priority: 2 }, FRIDAY)
    ).toStrictEqual({
      title: "Rinse the filter",
      due_at: "2026-08-28",
      priority: 2,
    });
  });

  it("refuses an empty title without saying so twice", () => {
    expect(quickAddReady({ ...QUICK_ADD_EMPTY, title: "   " })).toBe(false);
    expect(quickAddReady(draft)).toBe(true);
  });

  it("files into a project as a SECOND write, and never into the Inbox", () => {
    expect(quickAddFiling(draft, "t1")).toBeNull();
    expect(quickAddFiling({ ...draft, projectId: "p1" }, "t1")).toStrictEqual({
      task_id: "t1",
      sort_order: 0,
      project_id: "p1",
    });
  });
});

describe("the lands-in foot", () => {
  it("says the place and the vault, in that order", () => {
    expect(quickAddLandsIn({ projectName: "Kitchen", vault: "House" })).toBe(
      "Kitchen · House"
    );
  });

  it("calls the absence of a project the Inbox", () => {
    expect(quickAddLandsIn({ vault: "Mine" })).toBe(`${GROUPS.inbox} · Mine`);
  });
});
