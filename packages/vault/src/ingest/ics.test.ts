// Direct ICS parser unit tests (#545) — pure string→struct.

import { describe, expect, test } from "vitest";

import { parseIcs } from "./ics.js";

describe("ics", () => {
  test("parseIcs returns empty for calendars with no VEVENT", () => {
    expect(
      parseIcs("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n")
    ).toStrictEqual([]);
    expect(parseIcs("")).toStrictEqual([]);
  });

  test("parseIcs unfolds lines and unescapes SUMMARY/DESCRIPTION", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:evt-1@example.com",
      "SUMMARY:Cardiology follow-up\\, Dr Mehta",
      "DESCRIPTION:Bring the 90-day",
      "  vitals summary",
      "DTSTART;TZID=Asia/Kolkata:20260709T103000",
      "DTEND;TZID=Asia/Kolkata:20260709T110000",
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: "evt-1@example.com",
      summary: "Cardiology follow-up, Dr Mehta",
      description: "Bring the 90-day vitals summary",
      dtstart: "2026-07-09T10:30:00",
      dtend: "2026-07-09T11:00:00",
      startTz: "Asia/Kolkata",
      status: "confirmed",
      rrule: null,
    });
  });

  test("parseIcs converts Zulu datetimes and keeps RRULE / STATUS", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:standup",
      "SUMMARY:Weekly standup",
      "DTSTART:20260706T033000Z",
      "DTEND:20260706T034500Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "STATUS:TENTATIVE",
      "END:VEVENT",
    ].join("\r\n");
    const [event] = parseIcs(ics);
    expect(event).toMatchObject({
      uid: "standup",
      dtstart: "2026-07-06T03:30:00Z",
      dtend: "2026-07-06T03:45:00Z",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      status: "tentative",
      startTz: null,
    });
  });

  test("parseIcs maps date-only DTSTART to ISO day and drops incomplete events", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:all-day",
      "SUMMARY:Holiday",
      "DTSTART:20260704",
      "STATUS:CANCELLED",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:missing-summary",
      "DTSTART:20260705T100000Z",
      "END:VEVENT",
    ].join("\n");
    const events = parseIcs(ics);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: "all-day",
      dtstart: "2026-07-04",
      status: "cancelled",
    });
  });

  test("parseIcs ignores unknown properties without mangling known ones", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:x",
      "SUMMARY:Meet",
      "X-CUSTOM:ignore-me",
      "DTSTART:20260101T120000Z",
      "END:VEVENT",
    ].join("\r\n");
    expect(parseIcs(ics)[0]).toMatchObject({ uid: "x", summary: "Meet" });
  });

  test("parseIcs rejects a truncated or nested event", () => {
    expect(() =>
      parseIcs(
        ["BEGIN:VEVENT", "UID:x", "SUMMARY:Meet", "DTSTART:20260101"].join("\n")
      )
    ).toThrow(/truncated ICS VEVENT/u);
    expect(() => parseIcs(["BEGIN:VEVENT", "BEGIN:VEVENT"].join("\n"))).toThrow(
      /nested VEVENT/u
    );
  });
});
