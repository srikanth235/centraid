// The scope panel's action mapping and the RSVP projection — the two places
// this app turns a press into a vault ask, and the one place it puts the
// answer back on screen before the vault has replied.

import { describe, expect, it } from "vitest";

import {
  RSVP_ANSWERS,
  needsScopePanel,
  occurrenceEdit,
  projectRsvp,
  projectRsvpInto,
} from "./edits.ts";
import type { AgEvent, Attendee } from "./types.ts";

const series: AgEvent = {
  event_id: "standup",
  dtstart: "2026-08-21T09:00:00.000Z",
  original_start: "2026-08-21T09:00:00.000Z",
  rrule: "FREQ=WEEKLY",
};

describe("the scope panel maps a press to one edit-occurrence ask", () => {
  it("sends override for each of the three scopes when the member is editing", () => {
    for (const scope of ["occurrence", "future", "series"] as const) {
      const payload = occurrenceEdit({ event: series, scope, intent: "edit" });
      expect(payload?.action, scope).toBe("override");
      expect(payload?.scope, scope).toBe(scope);
      expect(payload?.event_id, scope).toBe("standup");
    }
  });

  it("keys the ask by the stable instance identity", () => {
    expect(
      occurrenceEdit({ event: series, scope: "occurrence", intent: "edit" })
        ?.original_start
    ).toBe("2026-08-21T09:00:00.000Z");
  });

  it("falls back to the row's own start where there is no instance identity", () => {
    const oneOff: AgEvent = { event_id: "lunch", dtstart: "2026-08-21T12:00:00.000Z" };
    expect(
      occurrenceEdit({ event: oneOff, scope: "occurrence", intent: "edit" })
        ?.original_start
    ).toBe("2026-08-21T12:00:00.000Z");
  });

  it("carries the changes on an edit and nothing at all on a skip", () => {
    const edited = occurrenceEdit({
      event: series,
      scope: "occurrence",
      intent: "edit",
      changes: { summary: "Moved" },
    });
    expect(edited?.summary).toBe("Moved");
    const skipped = occurrenceEdit({
      event: series,
      scope: "occurrence",
      intent: "skip",
      changes: { summary: "Moved" },
    });
    expect(skipped?.action).toBe("skip");
    expect(skipped?.summary).toBeUndefined();
  });

  it("REFUSES to skip a whole series, so no control is drawn for it", () => {
    expect(occurrenceEdit({ event: series, scope: "series", intent: "skip" })).toBeNull();
    expect(occurrenceEdit({ event: series, scope: "future", intent: "skip" })?.scope).toBe(
      "future"
    );
  });

  it("asks the scope question only of a repeating event", () => {
    expect(needsScopePanel(series)).toBe(true);
    expect(
      needsScopePanel({
        event_id: "instance",
        dtstart: series.dtstart,
        is_recurrence_instance: true,
      })
    ).toBe(true);
    expect(needsScopePanel({ event_id: "lunch", dtstart: series.dtstart })).toBe(false);
  });
});

describe("an RSVP is projected back into the guest list", () => {
  const guests: Attendee[] = [
    { party_id: "me", name: "You", partstat: "needs-action", is_you: true },
    { party_id: "dana", name: "Dana", partstat: "accepted" },
  ];

  it("replaces one answer and leaves every other row alone", () => {
    const next = projectRsvp(guests, "me", "declined");
    expect(next.map((guest) => guest.partstat)).toStrictEqual([
      "declined",
      "accepted",
    ]);
    expect(next).toHaveLength(guests.length);
  });

  it("never invents a row for somebody who is not on the list", () => {
    expect(projectRsvp(guests, "stranger", "accepted")).toStrictEqual(guests);
    expect(projectRsvp(undefined, "me", "accepted")).toStrictEqual([]);
  });

  it("carries all three answers", () => {
    for (const answer of RSVP_ANSWERS)
      expect(projectRsvp(guests, "me", answer)[0]?.partstat).toBe(answer);
  });

  it("moves every occurrence of the series together, since the vault will", () => {
    const rows: AgEvent[] = [
      {
        event_id: "standup",
        dtstart: "2026-08-21T09:00:00.000Z",
        instance_key: "standup:1",
        attendees: guests,
      },
      {
        event_id: "standup",
        dtstart: "2026-08-28T09:00:00.000Z",
        instance_key: "standup:2",
        attendees: guests,
      },
      { event_id: "other", dtstart: "2026-08-21T14:00:00.000Z", attendees: guests },
    ];
    const next = projectRsvpInto(rows, "standup", "me", "tentative");
    expect(next[0]?.attendees?.[0]?.partstat).toBe("tentative");
    expect(next[1]?.attendees?.[0]?.partstat).toBe("tentative");
    expect(next[2]?.attendees?.[0]?.partstat).toBe("needs-action");
  });
});
