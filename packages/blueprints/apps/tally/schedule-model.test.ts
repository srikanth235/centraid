// A schedule is a sentence — and where it cannot be, there is no preview.
//
// The fallback is the point of this file. `queries/dashboard.ts` asks the
// shared time core to phrase each rule and hands the answer over as `preview`;
// what is pinned here is that an ABSENT answer produces no preview at all
// rather than raw rule syntax on a member-facing surface, and that a template
// missing any field the save command requires withholds its acts instead of
// sending a write the vault would refuse.
import { describe, expect, it } from "vitest";

import {
  dueLabel,
  dueNext,
  daysUntil,
  scheduleSentence,
  statusChip,
  templateSaveBase,
  weightedSplits,
} from "./schedule-model.ts";
import type { RecurringTemplate } from "./types.ts";

const WHOLE: RecurringTemplate = {
  template_id: "r1",
  group_id: "flat",
  description: "Rent",
  original_amount_minor: 145_000,
  original_currency: "GBP",
  settlement_currency: "GBP",
  time_zone: "Europe/London",
  status: "active",
  preview: "the 1st of every month",
  next_start: "2026-09-01T09:00:00.000Z",
  paid_by: "me",
  category: "rent",
  splits_json: '[{"party_id":"me","weight":2},{"party_id":"ana","weight":1}]',
  rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
  anchor_start: "2024-03-01T09:00:00.000Z",
};

describe("the sentence, or nothing at all", () => {
  it("takes the summariser's own words", () => {
    expect(scheduleSentence(WHOLE)).toBe("the 1st of every month");
  });

  it.each([
    ["null", null],
    ["absent", undefined],
    ["blank", "   "],
  ])("drops the preview entirely when it is %s", (_label, preview) => {
    expect(scheduleSentence({ preview })).toBeNull();
  });
});

describe("the status word a row wears", () => {
  it("says nothing about the ordinary case", () => {
    expect(statusChip(WHOLE)).toBe("");
  });

  it("names a paused or ended template", () => {
    expect(statusChip({ ...WHOLE, status: "paused" })).toBe("Paused");
    expect(statusChip({ ...WHOLE, status: "ended" })).toBe("Ended");
  });
});

describe("the stored weights", () => {
  it("reads the vault's own JSON", () => {
    expect(weightedSplits(WHOLE)).toStrictEqual([
      { party_id: "me", weight: 2 },
      { party_id: "ana", weight: 1 },
    ]);
  });

  it.each([
    ["absent", undefined],
    ["not JSON", "{"],
    ["not an array", '{"party_id":"me"}'],
    ["weightless", '[{"party_id":"me"}]'],
    ["under one", '[{"party_id":"me","weight":0}]'],
  ])("reads %s as no weights at all", (_label, splits_json) => {
    expect(weightedSplits({ ...WHOLE, splits_json })).toStrictEqual([]);
  });
});

describe("what a save would carry", () => {
  it("sends the WHOLE template back, because the command upserts", () => {
    const base = templateSaveBase(WHOLE);
    expect(base).toMatchObject({
      template_id: "r1",
      group_id: "flat",
      paid_by: "me",
      category: "rent",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
      anchor_start: "2024-03-01T09:00:00.000Z",
      time_zone: "Europe/London",
    });
    expect(base?.splits).toStrictEqual([
      { party_id: "me", weight: 2 },
      { party_id: "ana", weight: 1 },
    ]);
  });

  it("carries the rate provenance only where the template has one", () => {
    expect(templateSaveBase(WHOLE)).not.toHaveProperty("rate_source");
    expect(
      templateSaveBase({ ...WHOLE, rate_scaled: 1_163_600, rate_scale: 6 })
    ).toMatchObject({ rate_scaled: 1_163_600, rate_scale: 6 });
  });

  it.each(["paid_by", "category", "rrule", "anchor_start"] as const)(
    "withholds the acts when %s is missing",
    (field) => {
      expect(templateSaveBase({ ...WHOLE, [field]: undefined })).toBeNull();
    }
  );

  it("withholds the acts when the splits cannot be read", () => {
    expect(templateSaveBase({ ...WHOLE, splits_json: "{" })).toBeNull();
  });
});

describe("when an occurrence falls", () => {
  const now = "2026-08-26T10:00:00.000Z";

  it.each([
    ["2026-08-26T09:00:00.000Z", "due today"],
    ["2026-08-27T09:00:00.000Z", "due tomorrow"],
    ["2026-08-30T09:00:00.000Z", "due in 4 days"],
    ["2026-08-25T09:00:00.000Z", "1 day past its date"],
    ["2026-08-20T09:00:00.000Z", "6 days past its date"],
  ])("says %s is %s", (iso, expected) => {
    expect(dueLabel(iso, now)).toBe(expected);
  });

  it("says nothing about a date it cannot read", () => {
    expect(dueLabel("not a date", now)).toBeNull();
    expect(daysUntil("not a date", now)).toBeNull();
  });
});

describe("what will materialise next", () => {
  it("lists the active templates that have a next occurrence, soonest first", () => {
    const rows = dueNext(
      [
        { ...WHOLE, next_start: "2026-09-18T09:00:00.000Z" },
        {
          ...WHOLE,
          template_id: "r2",
          description: "Broadband",
          next_start: "2026-09-01T09:00:00.000Z",
        },
      ],
      "2026-08-26T10:00:00.000Z"
    );
    expect(rows.map((row) => row.description)).toStrictEqual([
      "Broadband",
      "Rent",
    ]);
  });

  it("leaves out a paused template, and one with no next occurrence", () => {
    expect(
      dueNext(
        [
          { ...WHOLE, status: "paused" },
          { ...WHOLE, template_id: "r3", next_start: null },
          { ...WHOLE, template_id: "r4", next_start: "" },
        ],
        "2026-08-26T10:00:00.000Z"
      )
    ).toStrictEqual([]);
  });
});
