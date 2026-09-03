import { describe, expect, it } from "vitest";

import { ALL, INBOX, LOGBOOK, SEARCH, UPCOMING } from "./shelves.ts";
import * as copy from "./view-copy.ts";

const BANNED =
  /\b(?:please|successfully|simply|in order to|you can|we're sorry)\b/iu;

const EVERY_STRING: string[] = [
  copy.TODAY_DONE,
  copy.TODAY_EMPTY,
  copy.TODAY_EMPTY_SUB,
  copy.DAY_ONE,
  ...copy.DAY_ONE_ACTS,
  copy.REENTRY_LEAD_A,
  copy.REENTRY_LEAD_B,
  copy.REENTRY_FOOT_A,
  copy.REENTRY_FOOT_B,
  copy.REENTRY_NONE,
  copy.MISSED_NOTE_A,
  copy.MISSED_NOTE_B,
  copy.ANCHOR_NOTE,
  copy.DATE_ONLY_REMINDER,
  copy.REMINDER_NOTE_A,
  copy.REMINDER_NOTE_B,
  copy.PRIORITY_NOTE_A,
  copy.PRIORITY_NOTE_B,
  copy.EFFORT_NOTE_A,
  copy.EFFORT_NOTE_B,
  copy.SUBTASK_CAP,
  copy.PROMOTION_A,
  copy.PROMOTION_B,
  copy.PROMOTION_VERB,
  copy.TAGS_NOTE_A,
  copy.TAGS_NOTE_B,
  copy.HOME_VAULT_NOTE_A,
  copy.HOME_VAULT_NOTE_B,
  copy.WONT_DO,
  copy.LIFECYCLE.start,
  copy.LIFECYCLE.stop,
  copy.PENDING_CHIP,
  copy.PENDING_ROW,
  copy.VAULT_MARKER,
  copy.QUICK_ADD.pointerPlaceholder,
  copy.QUICK_ADD.touchPlaceholder,
  copy.QUICK_ADD.assistant,
  copy.NOTIFY_COPY.rule,
  copy.DENIED.title,
  copy.DENIED.bodyA,
  copy.DENIED.bodyB,
  copy.RELEASE_CONFIRM.title,
  copy.RELEASE_CONFIRM.bodyA,
  copy.RELEASE_CONFIRM.bodyB,
  copy.DELETE_CONFIRM.title,
  copy.DELETE_CONFIRM.bodyA,
  copy.DELETE_CONFIRM.bodyB,
  copy.NEW_PROJECT.note,
  ...copy.LENSES.map((lens) => lens.label),
  ...copy.QUICK_ADD_WHEN.map((choice) => choice.label),
  ...Object.values(copy.SORT_LABELS),
  ...copy.ANCHOR_CARDS.flatMap((card) => [card.head, card.body, card.tag]),
];

describe("the copy table", () => {
  it.each(EVERY_STRING)("%s carries no filler and no apology", (line) => {
    expect(BANNED.test(line)).toBe(false);
  });

  it.each(EVERY_STRING)("%s stays one thought under the ceiling", (line) => {
    expect(line.length).toBeLessThanOrEqual(120);
    const inner = line.match(/[.!?…](?=\s+["'(]?\p{Lu})/gu)?.length ?? 0;
    const tail = /[.!?…]["')]?\s*$/u.test(line) ? 1 : 0;
    expect(inner + tail).toBeLessThanOrEqual(1);
  });

  it("says the two Today quiets as two distinct facts", () => {
    expect(copy.TODAY_DONE).toBe("Everything due today is done.");
    expect(copy.TODAY_EMPTY).toBe("Nothing is scheduled for today.");
    expect(copy.TODAY_DONE).not.toBe(copy.TODAY_EMPTY);
  });

  it("keeps overdue shame-free: a count and the reassurance, no scold", () => {
    expect(copy.overdueMeta(3)).toBe("3 · nothing was deleted");
    expect(copy.GROUPS.moveAll).toBe("Move all to today");
    expect(copy.GROUPS.catchUp).toBe("Catch up");
  });

  it("states the re-entry notice with the count and the reassurance", () => {
    expect(copy.reentryNotice(16, 34)).toContain("You were away 16 days");
    expect(copy.reentryNotice(16, 34)).toContain("Nothing was deleted.");
    expect(copy.reentryHead(16, 34)).toBe("16 days away · 34 tasks came due");
  });

  it("renders a missed collapse as one row's words, never as copies", () => {
    expect(copy.missedLabel(4, "Friday")).toBe("missed 4 · next is Friday");
  });

  it("says where the next occurrence landed on a repeating check-off", () => {
    expect(copy.doneNext("Friday")).toBe("Done · the next one is Friday");
  });

  it("declares the window as a window on both surfaces", () => {
    expect(copy.windowEndBoard(60, 214)).toBe(
      "60 of 214 · this is a window, not everything open"
    );
    expect(copy.windowEndLogbook(50, "4,312")).toBe(
      "50 of 4,312 · the vault answers with the 50 most recent"
    );
  });

  it("counts nothing at the member in the Inbox", () => {
    expect(copy.inboxMeta(5)).toBe("5 · nothing is counting at you");
  });

  it("names the missing slice when a vault does not answer", () => {
    expect(copy.partialNotice("House", 38)).toBe(
      "House did not answer · showing 38 of your own tasks."
    );
  });

  it("keeps the release confirm plain and the delete confirm the destructive one", () => {
    expect(copy.RELEASE_CONFIRM.verb).toBe("Release");
    expect(copy.DELETE_CONFIRM.verb).toBe("Delete");
    expect(copy.RELEASE_CONFIRM.bodyB).toBe("Nothing is erased.");
  });

  it("makes the anchor two sentences a member could say out loud", () => {
    expect(copy.ANCHOR_CARDS.map((card) => card.value)).toStrictEqual([
      "scheduled",
      "completion",
    ]);
    expect(copy.ANCHOR_CARDS[0]?.tag).toBe("Rent.");
    expect(copy.ANCHOR_CARDS[1]?.tag).toBe("Watering.");
  });

  it("names every field the detail place draws, one word for one thing", () => {
    for (const label of Object.values(copy.FIELDS)) {
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(Object.values(copy.FIELDS)).size).toBe(
      Object.values(copy.FIELDS).length
    );
  });

  it("says the two logbook outcomes as outcomes, never as a verdict", () => {
    expect(copy.DONE).toBe("Done");
    expect(copy.WONT_DO).toBe("Won't do");
  });

  it("offers four priorities and five efforts, absent by default", () => {
    expect(copy.PRIORITY_CHIPS).toStrictEqual(["None", "Soon", "Next", "Now"]);
    expect(copy.EFFORT_CHIPS[0]).toBe("None");
  });

  it("names each shelf in the bar's own words", () => {
    expect(copy.shelfCopy(null).title).toBe("Today");
    expect(copy.shelfCopy(UPCOMING).title).toBe("Upcoming");
    expect(copy.shelfCopy(INBOX).title).toBe("Inbox");
    expect(copy.shelfCopy(ALL).unit).toBe("tasks");
    expect(copy.shelfCopy(SEARCH).unit).toBe("hits");
    expect(copy.shelfCopy(LOGBOOK).title).toBe("Logbook");
    expect(copy.shelfCopy(null, "Kitchen").title).toBe("Kitchen");
  });

  it("names the toolbar's three lenses and its two orders", () => {
    expect(copy.LENSES.map((lens) => lens.label)).toStrictEqual([
      "Fits in 30 min",
      "Mine",
      "House",
    ]);
    expect(copy.SORT_LABELS.priority).toBe("Priority within date");
    expect(copy.SORT_LABELS.manual).toBe("Manual order");
  });

  it("counts the board in the place's own unit, singular at one", () => {
    expect(copy.boardCount(1, "tasks")).toBe("1 task");
    expect(copy.boardCount(12, "tasks")).toBe("12 tasks");
  });

  it("offers quick add five Whens, with No date among them", () => {
    expect(copy.QUICK_ADD_WHEN.map((choice) => choice.label)).toStrictEqual([
      "Today",
      "Tomorrow",
      "This weekend",
      "Next week",
      "No date",
    ]);
  });

  it("says what a project needs before it can be one", () => {
    expect(copy.AREAS).toStrictEqual(["Home", "Work"]);
    expect(copy.NEW_PROJECT.note).toContain("area");
    expect(copy.SECTIONS.none).toBe("No section");
  });

  it("lists the keyboard map the spec draws", () => {
    expect(copy.SHORTCUTS.map((entry) => entry.keys)).toStrictEqual([
      "q",
      "c",
      "/",
      "1–4",
      "t",
      "e",
      "j / k",
      "Esc",
      "?",
    ]);
  });
});
