// D2/S11/S14 (#1015 Wave 3). Agenda's own defects were vocabulary rather than
// casing: the event screen printed the iCalendar `partstat` value verbatim
// (agenda/findings#16) and the error card called the app "Calendar"
// (findings#18). This sweeps the tables that now hold both, and keeps the
// casing honest while it is there.

import { describe, expect, it } from "vitest";

import {
  ALL_DAY,
  BAND_SEARCH,
  CONTINUED,
  CONTINUES,
  EDITOR_TITLE,
  NEW_EVENT,
  NEXT,
  NOW,
  PARKED_CANCEL_BODY,
  PARKED_CANCEL_REVIEW,
  PARKED_CANCEL_TITLE,
  PARTSTAT_CHOOSE,
  PARTSTAT_SAID,
  PENDING_CANCEL_CHIP,
  PENDING_MARK,
  PREVIOUS,
  QUICK_ADD,
  QUICK_DISCARD,
  QUICK_EDIT,
  QUICK_PLACEHOLDER,
  QUICK_TITLE,
  SEARCH_LABEL,
  STATE_DAY_ONE,
  STATE_DAY_ONE_ACTION,
  STATE_OFFLINE,
  STATE_STALE,
  TODAY,
  VIEW_LABELS,
  partstatLabel,
} from "@centraid/blueprints/apps/agenda/view-copy";

import { titleCaseWords } from "../../kit/copy-case";
import { readFailure } from "../../kit/rooms/read-failure";
import { AGENDA_BAND_DESTINATIONS } from "./agenda-band";

/** Capitalised for what they name: Agenda's places and the apps it links to. */
const PROPER_NOUNS = new Set([
  "Agenda",
  "Schedule",
  "Day",
  "Week",
  "Month",
  "Search",
  "More",
  "Today",
  "Now",
  "Tasks",
  "Approvals",
  "Calendars",
  "Going",
  "Maybe",
  "Add",
  "Edit",
  "Discard",
  "Offline",
  "Review",
  "The",
  "This",
  "Part",
  "Nothing",
  "Hidden",
  "No",
  "Not",
  "All",
]);

describe("every Agenda copy table is sentence case (D2, #1015)", () => {
  it.each([
    ["band destinations", AGENDA_BAND_DESTINATIONS.map((d) => d.label)],
    ["the views", Object.values(VIEW_LABELS)],
    ["the attendance enum", Object.values(PARTSTAT_SAID)],
    ["the RSVP chips", Object.values(PARTSTAT_CHOOSE)],
    ["the day's own words", [TODAY, PREVIOUS, NEXT, NOW, ALL_DAY]],
    ["the run-on marks", [CONTINUES, CONTINUED]],
    ["the pending marks", [PENDING_MARK, PENDING_CANCEL_CHIP]],
    [
      "the composer",
      [QUICK_TITLE, QUICK_PLACEHOLDER, QUICK_ADD, QUICK_EDIT, QUICK_DISCARD],
    ],
    ["the editor", [EDITOR_TITLE, NEW_EVENT, SEARCH_LABEL, BAND_SEARCH]],
    [
      "the parked cancellation",
      [PARKED_CANCEL_TITLE, PARKED_CANCEL_BODY, PARKED_CANCEL_REVIEW],
    ],
    [
      "the standing states",
      [STATE_OFFLINE, STATE_STALE, STATE_DAY_ONE, STATE_DAY_ONE_ACTION],
    ],
  ])("%s", (_where, labels) => {
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels)
      expect({
        label,
        titleCase: titleCaseWords(label, PROPER_NOUNS),
      }).toStrictEqual({ label, titleCase: [] });
  });
});

describe("Agenda speaks its own vocabulary (#1015 S11/S14)", () => {
  // findings#16: the screen printed `String(attendee["partstat"])` for every
  // value but `needs-action`, so the member read the storage format.
  it("says the attendance enum in words, and never the raw value", () => {
    expect(partstatLabel("accepted")).toBe("Going");
    expect(partstatLabel("declined")).toBe("Not going");
    expect(partstatLabel("tentative")).toBe("Maybe");
    expect(partstatLabel("needs-action")).toBe("No answer yet");
  });

  // SABOTAGE: a partstat this seat has never met is UNANSWERED, not printed.
  it("SABOTAGE: an unknown partstat is still a sentence", () => {
    for (const raw of ["delegated", "X-SOMETHING", "", undefined, null, 7])
      expect(partstatLabel(raw)).toBe("No answer yet");
  });

  // findings#18: the app is Agenda everywhere but its own error card.
  it("calls the app by its name when a read does not land", () => {
    const say = (unreachable: boolean): string | undefined =>
      readFailure({
        failed: !unreachable,
        noun: "Agenda",
        onRetry: () => undefined,
        unreachable,
      })?.title;
    expect(say(true)).toBe("Agenda is not connected");
    expect(say(false)).toBe("Agenda could not be loaded");
    for (const said of [say(true), say(false)])
      expect(said).not.toContain("Calendar");
  });

  // S14: no Agenda screen may put the read's exception on the surface again.
  it("SABOTAGE: the room's body is never fed the hook's error string", () => {
    expect(
      readFailure({
        failed: true,
        noun: "Agenda",
        onRetry: () => undefined,
        unreachable: false,
      })?.retry.label
    ).toBe("Try again");
  });
});
