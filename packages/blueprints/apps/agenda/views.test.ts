// The view derivations, asserted directly rather than through a rendered
// tree: where a grid lands when it opens, which day an event is drawn on, what
// counts as all-day, what a multi-day run does, and who is waiting on whom.

import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import { appBar } from "./frame.tsx";
import type { AgEvent, ViewKind } from "./types.ts";
import { SEARCH_LABEL } from "./view-copy.ts";
import {
  BAND_DESTINATIONS,
  BAND_SEARCH_ID,
  GRID_OPEN_HOUR,
  POINTER_VIEWS,
  TOUCH_VIEWS,
  VIEWS,
  bandActiveId,
  bucketByDay,
  defaultView,
  findEvent,
  layoutDay,
  monthGridDays,
  nowAnchor,
  nowLineMinutes,
  rangeForView,
  resolveView,
  rowKey,
  segmentBox,
  splitDay,
  visibleEvents,
  waitingOn,
  weekDays,
} from "./views.ts";

/** A local-time instant, so these assertions do not depend on the runner's
 *  zone the way a hardcoded `Z` string would. */
function at(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

function event(
  partial: Partial<AgEvent> & { event_id: string; dtstart: string }
): AgEvent {
  return { summary: "Something", ...partial };
}

describe("the anchor lands at now, not at midnight", () => {
  it("puts today's anchor an hour above the current time", () => {
    const now = new Date(2026, 7, 21, 14, 30);
    expect(nowAnchor(now, now)).toBe(13 * 60 + 30);
  });

  it("never lands above the top of the day", () => {
    const now = new Date(2026, 7, 21, 0, 15);
    expect(nowAnchor(now, now)).toBe(0);
  });

  it("opens another day at the working morning rather than at midnight", () => {
    const now = new Date(2026, 7, 21, 14, 30);
    const other = new Date(2026, 7, 25);
    expect(nowAnchor(other, now)).toBe(GRID_OPEN_HOUR * 60);
    expect(nowAnchor(other, now)).not.toBe(0);
  });

  it("draws the now line on exactly the day that is today", () => {
    const now = new Date(2026, 7, 21, 9, 42);
    expect(nowLineMinutes("2026-08-21", now)).toBe(9 * 60 + 42);
    expect(nowLineMinutes("2026-08-22", now)).toBeNull();
  });
});

describe("which views a surface offers", () => {
  it("keeps all five on pointer and offers neither Month nor Week on touch", () => {
    expect(POINTER_VIEWS).toStrictEqual(VIEWS);
    expect(TOUCH_VIEWS).not.toContain("month");
    expect(TOUCH_VIEWS).not.toContain("week");
  });

  it("resolves a POINTER preference the touch seat cannot draw", () => {
    // Not a destination falling back: nothing the band offers lands here.
    expect(resolveView("month", true)).toBe("day");
    expect(resolveView("week", true)).toBe("day");
    expect(resolveView("waiting", true)).toBe("waiting");
    expect(resolveView("month", false)).toBe("month");
  });

  it("defaults to Day on touch and to the knob on pointer", () => {
    expect(defaultView(true)).toBe("day");
    expect(defaultView(false, "week")).toBe("week");
    expect(defaultView(false, "nonsense")).toBe("month");
  });
});

function flatten(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement(node)) return [];
  const { children } = node.props as { children?: ReactNode };
  return [node, ...flatten(children)];
}

function barOffersSearch(compact: boolean): boolean {
  const contribution = appBar({
    view: "day",
    range: "Today",
    count: 0,
    compact,
    onSetView: () => undefined,
    onToday: () => undefined,
    onStep: () => undefined,
    onNew: () => undefined,
    onSearch: () => undefined,
  });
  return flatten(contribution.actions).some(
    (element) => (element.props as { label?: string }).label === SEARCH_LABEL
  );
}

describe("the compact band is the only band", () => {
  it("offers no destination that draws a different view", () => {
    for (const destination of BAND_DESTINATIONS) {
      if (!VIEWS.includes(destination.id as ViewKind)) continue;
      const view = destination.id as ViewKind;
      expect(resolveView(view, true), destination.id).toBe(view);
      expect(bandActiveId(view), destination.id).toBe(view);
    }
    expect(
      BAND_DESTINATIONS.map((destination) => destination.id)
    ).not.toContain("month");
  });

  it("lights nothing for a view it does not carry", () => {
    expect(bandActiveId("month")).toBeUndefined();
    expect(bandActiveId("week")).toBeUndefined();
  });

  it("carries Search, which is what lets the bar withdraw its own on compact", () => {
    // `_shared/app-frame.tsx` withdraws it on the band's promise to carry it.
    expect(barOffersSearch(false)).toBe(true);
    expect(barOffersSearch(true)).toBe(false);
    expect(
      BAND_DESTINATIONS.some(
        (destination) => destination.id === BAND_SEARCH_ID
      ),
      "compact withdrew Search from the bar and the band does not carry it"
    ).toBe(true);
  });

  it("stays inside the frame's cap with More as the fifth", () => {
    expect(BAND_DESTINATIONS.length).toBeLessThanOrEqual(4);
  });
});

describe("each view reads a bounded window", () => {
  const anchor = new Date(2026, 7, 21);

  it("bounds the three grids at both ends", () => {
    for (const view of ["month", "week", "day"] as const) {
      const range = rangeForView(view, anchor);
      expect(range.to, view).toBeTypeOf("string");
      expect(new Date(range.from).getTime(), view).toBeLessThan(
        new Date(range.to as string).getTime()
      );
    }
  });

  it("leaves the forward lists open-ended, so the query owns the ceiling", () => {
    expect(rangeForView("schedule", anchor).to).toBeUndefined();
    expect(rangeForView("waiting", anchor).to).toBeUndefined();
  });

  it("draws 42 month cells and 7 week columns", () => {
    expect(monthGridDays(anchor)).toHaveLength(42);
    expect(weekDays(anchor)).toHaveLength(7);
    expect(weekDays(anchor)[0]).toBe("2026-08-17");
  });
});

describe("bucketing puts an event on the days it occupies", () => {
  it("keys a timed event by its own local day", () => {
    const buckets = bucketByDay([
      event({
        event_id: "e1",
        dtstart: at(2026, 8, 21, 9),
        dtend: at(2026, 8, 21, 10),
      }),
    ]);
    expect([...buckets.keys()]).toStrictEqual(["2026-08-21"]);
    expect(buckets.get("2026-08-21")?.[0]?.clamped).toBe(false);
  });

  it("keeps a MULTI-DAY run visible on every local day it spans", () => {
    const buckets = bucketByDay([
      event({
        event_id: "e2",
        dtstart: at(2026, 8, 21, 22),
        dtend: at(2026, 8, 23, 9),
      }),
    ]);
    expect([...buckets.keys()]).toStrictEqual([
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ]);
    const first = buckets.get("2026-08-21")?.[0];
    const middle = buckets.get("2026-08-22")?.[0];
    const last = buckets.get("2026-08-23")?.[0];
    expect(first?.startsHere).toBe(true);
    expect(first?.clamped).toBe(true);
    expect(first?.endsHere).toBe(false);
    expect(middle?.startsHere).toBe(false);
    expect(middle?.spansAll).toBe(true);
    expect(last?.endsHere).toBe(true);
    expect(last?.clamped).toBe(false);
  });

  it("keeps an all-day run on every civil day the member named, end inclusive", () => {
    const buckets = bucketByDay([
      event({
        event_id: "away",
        dtstart: "2026-08-21",
        dtend: "2026-08-23",
        recurrence_semantics: "all-day",
      }),
    ]);
    expect([...buckets.keys()]).toStrictEqual([
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ]);
  });

  it("an all-day recurring event lands on the day it names", () => {
    const buckets = bucketByDay([
      event({
        event_id: "holiday",
        dtstart: "2026-11-15",
        dtend: "2026-11-15",
        recurrence_semantics: "all-day",
        rrule: "FREQ=YEARLY",
      }),
    ]);
    expect([...buckets.keys()]).toStrictEqual(["2026-11-15"]);
  });

  it("separates all-day from timed by the vault's own semantics", () => {
    const buckets = bucketByDay([
      event({
        event_id: "whole",
        dtstart: at(2026, 8, 21),
        dtend: at(2026, 8, 21, 23, 59),
        recurrence_semantics: "all-day",
      }),
      event({
        event_id: "timed",
        dtstart: at(2026, 8, 21, 9),
        dtend: at(2026, 8, 21, 10),
      }),
    ]);
    const split = splitDay(buckets.get("2026-08-21") ?? []);
    expect(split.allDay.map((s) => s.ev.event_id)).toStrictEqual(["whole"]);
    expect(split.timed.map((s) => s.ev.event_id)).toStrictEqual(["timed"]);
  });

  it("orders a day's segments by when they start", () => {
    const buckets = bucketByDay([
      event({ event_id: "late", dtstart: at(2026, 8, 21, 15) }),
      event({ event_id: "early", dtstart: at(2026, 8, 21, 8) }),
    ]);
    expect(
      (buckets.get("2026-08-21") ?? []).map((s) => s.ev.event_id)
    ).toStrictEqual(["early", "late"]);
  });

  it("drops a row whose start the vault could not parse rather than guessing", () => {
    expect(
      bucketByDay([event({ event_id: "bad", dtstart: "not a date" })]).size
    ).toBe(0);
  });
});

describe("overlaps take side-by-side columns", () => {
  it("splits a cluster evenly and leaves a lone event whole", () => {
    const buckets = bucketByDay([
      event({
        event_id: "a",
        dtstart: at(2026, 8, 21, 9),
        dtend: at(2026, 8, 21, 11),
      }),
      event({
        event_id: "b",
        dtstart: at(2026, 8, 21, 10),
        dtend: at(2026, 8, 21, 12),
      }),
      event({
        event_id: "c",
        dtstart: at(2026, 8, 21, 15),
        dtend: at(2026, 8, 21, 16),
      }),
    ]);
    const laid = layoutDay(buckets.get("2026-08-21") ?? []);
    const byId = new Map(laid.map((s) => [s.ev.event_id, s]));
    expect(byId.get("a")?.width).toBe(2);
    expect(byId.get("b")?.col).toBe(1);
    expect(byId.get("c")?.width).toBe(1);
  });

  it("gives a zero-length event a readable box rather than a hairline", () => {
    const buckets = bucketByDay([
      event({ event_id: "instant", dtstart: at(2026, 8, 21, 9) }),
    ]);
    const box = segmentBox((buckets.get("2026-08-21") ?? [])[0]!);
    expect(box.height).toBeGreaterThan(0);
    expect(box.top).toBeCloseTo(((9 * 60) / (24 * 60)) * 100, 5);
  });
});

describe("waiting on is the answers still owed", () => {
  const invited = event({
    event_id: "invite",
    dtstart: at(2026, 8, 21, 9),
    attendees: [
      { party_id: "me", name: "You", partstat: "needs-action", is_you: true },
      { party_id: "them", name: "Dana", partstat: "accepted" },
    ],
  });
  const answered = event({
    event_id: "answered",
    dtstart: at(2026, 8, 21, 11),
    attendees: [
      { party_id: "me", name: "You", partstat: "accepted", is_you: true },
    ],
  });
  const notMine = event({
    event_id: "theirs",
    dtstart: at(2026, 8, 21, 13),
    attendees: [{ party_id: "them", name: "Dana", partstat: "needs-action" }],
  });

  it("keeps only the events the owner has not answered", () => {
    expect(
      waitingOn([invited, answered, notMine]).map((ev) => ev.event_id)
    ).toStrictEqual(["invite"]);
  });

  it("reads a missing partstat as unanswered, not as an answer", () => {
    const blank = event({
      event_id: "blank",
      dtstart: at(2026, 8, 21, 15),
      attendees: [{ party_id: "me", name: "You", partstat: "", is_you: true }],
    });
    expect(waitingOn([blank])).toHaveLength(1);
  });
});

describe("row identity and calendar visibility", () => {
  it("keys an occurrence by its instance and still finds it by the series", () => {
    const occurrence = event({
      event_id: "series",
      dtstart: at(2026, 8, 21, 9),
      instance_key: "series:2026-08-21T09:00:00Z",
    });
    expect(rowKey(occurrence)).toBe("series:2026-08-21T09:00:00Z");
    expect(findEvent([occurrence], "series:2026-08-21T09:00:00Z")).toBe(
      occurrence
    );
    expect(findEvent([occurrence], "series")).toBe(occurrence);
    expect(findEvent([occurrence], "other")).toBeNull();
  });

  it("hides a calendar's rows without hiding the rows that have none", () => {
    const onCal = event({
      event_id: "on",
      dtstart: at(2026, 8, 21),
      calendar_id: "work",
    });
    const noCal = event({ event_id: "off", dtstart: at(2026, 8, 21) });
    expect(
      visibleEvents([onCal, noCal], new Set(["work"])).map((ev) => ev.event_id)
    ).toStrictEqual(["off"]);
  });
});
