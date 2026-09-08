import { describe, expect, it } from "vitest";

import {
  OCCURRENCE_LOCAL_START_COLUMN,
  occurrenceExceptionsOf,
  occurrenceKey,
  occurrenceKeysEqual,
  occurrenceKeyToken,
  occurrenceSearchWindow,
  overrideAt,
  readOccurrenceException,
  recurrenceExceptionsOf,
} from "./occurrence.js";

const KEY = occurrenceKey("core.event", "series-1", "2026-03-01T09:00");

describe(readOccurrenceException, () => {
  it("reads a stored row under the one column spelling", () => {
    const exception = readOccurrenceException({
      target_type: "core.event",
      target_id: "series-1",
      [OCCURRENCE_LOCAL_START_COLUMN]: "2026-03-01T09:00",
      recurrence_semantics: "floating",
      action: "override",
      scope: "future",
      override_json: '{"start":"2026-03-01T10:00"}',
    });
    expect(exception).toMatchObject({
      action: "override",
      scope: "future",
      key: {
        seriesType: "core.event",
        seriesId: "series-1",
        localStart: "2026-03-01T09:00",
        semantics: "floating",
      },
      override: { start: "2026-03-01T10:00" },
    });
  });

  it("returns null when the key is missing, and skips a broken override payload", () => {
    expect(readOccurrenceException({ target_id: "series-1" })).toBeNull();
    expect(
      readOccurrenceException({
        target_type: "core.event",
        target_id: "series-1",
        original_start_local: "2026-03-01T09:00",
        override_json: "{not json",
      })?.override
    ).toBeNull();
  });
});

describe(occurrenceExceptionsOf, () => {
  it("keeps one series, oldest first", () => {
    const rows = [
      {
        target_type: "core.event" as const,
        target_id: "series-1",
        original_start_local: "2026-03-08T09:00",
      },
      {
        target_type: "core.event" as const,
        target_id: "other",
        original_start_local: "2026-03-01T09:00",
      },
      {
        target_type: "core.event" as const,
        target_id: "series-1",
        original_start_local: "2026-03-01T09:00",
      },
    ];
    expect(
      occurrenceExceptionsOf(rows, {
        seriesType: "core.event",
        seriesId: "series-1",
      }).map((exception) => exception.key.localStart)
    ).toStrictEqual(["2026-03-01T09:00", "2026-03-08T09:00"]);
  });
});

describe(recurrenceExceptionsOf, () => {
  it("feeds the expander the stored wall clock and an override start when present", () => {
    const skip = readOccurrenceException({
      target_type: "core.event",
      target_id: "series-1",
      original_start_local: "2026-03-01T09:00",
    });
    const moved = readOccurrenceException({
      target_type: "core.event",
      target_id: "series-1",
      original_start_local: "2026-03-08T09:00",
      action: "override",
      override_json: '{"start":"2026-03-08T10:00"}',
    });
    expect(skip && moved).toBeTruthy();
    expect(recurrenceExceptionsOf([skip!, moved!])).toStrictEqual([
      {
        originalStart: "2026-03-01T09:00",
        action: "skip",
        scope: "occurrence",
      },
      {
        originalStart: "2026-03-08T09:00",
        action: "override",
        scope: "occurrence",
        start: "2026-03-08T10:00",
      },
    ]);
  });
});

describe(overrideAt, () => {
  it("prefers an occurrence override, else the latest future override at or before", () => {
    const exceptions = occurrenceExceptionsOf(
      [
        {
          target_type: "core.event",
          target_id: "series-1",
          original_start_local: "2026-03-01T09:00",
          scope: "future",
          action: "override",
          override_json: '{"title":"from March"}',
        },
        {
          target_type: "core.event",
          target_id: "series-1",
          original_start_local: "2026-03-08T09:00",
          scope: "occurrence",
          action: "override",
          override_json: '{"title":"just the 8th"}',
        },
      ],
      { seriesType: "core.event", seriesId: "series-1" }
    );
    expect(overrideAt(exceptions, "2026-03-08T09:00")).toStrictEqual({
      title: "just the 8th",
    });
    expect(overrideAt(exceptions, "2026-03-15T09:00")).toStrictEqual({
      title: "from March",
    });
    expect(overrideAt(exceptions, "2026-02-01T09:00")).toBeNull();
  });
});

describe(occurrenceSearchWindow, () => {
  it("is a bound around the wall clock, not a conversion in the host zone", () => {
    const window = occurrenceSearchWindow("2026-03-29T09:00:00");
    expect(window).not.toBeNull();
    expect(Date.parse(window!.from)).toBeLessThan(Date.parse(window!.to));
    expect(occurrenceSearchWindow("not-a-time")).toBeNull();
  });
});

describe(occurrenceKeyToken, () => {
  it("treats semantics as part of identity", () => {
    const zoned = occurrenceKey(
      "core.event",
      "series-1",
      "2026-03-01T09:00",
      "zoned"
    );
    const floating = occurrenceKey(
      "core.event",
      "series-1",
      "2026-03-01T09:00",
      "floating"
    );
    expect(occurrenceKeysEqual(KEY, zoned)).toBe(true);
    expect(occurrenceKeysEqual(zoned, floating)).toBe(false);
    expect(occurrenceKeyToken(zoned)).toContain("zoned");
  });
});
