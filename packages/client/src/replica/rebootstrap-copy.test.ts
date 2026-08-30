import { describe, expect, test } from "vitest";

import {
  isRebootstrapVerdict,
  rebootstrapNoticeFor,
  rebootstrapNoticeFrom,
} from "./rebootstrap-copy.js";
import type { ReplicaRebootstrapVerdict } from "./rebootstrap-copy.js";

const VERDICTS: readonly ReplicaRebootstrapVerdict[] = [
  "epoch-mismatch",
  "retention",
  "cursor-ahead",
  "initial",
  "epoch-changed",
  "snapshot-retention",
  "shape-changed",
  "checkpoint-incompatible",
  "invalid-cursor",
];

describe("every verdict has a sentence", () => {
  test("no verdict renders an empty headline or a missing why", () => {
    for (const verdict of VERDICTS) {
      const notice = rebootstrapNoticeFor(verdict);
      expect(notice.headline.length).toBeGreaterThan(0);
      expect(notice.detail.length).toBeGreaterThan(0);
    }
  });

  test("no sentence is the generic error this replaces", () => {
    for (const verdict of VERDICTS) {
      const notice = rebootstrapNoticeFor(verdict);
      expect(`${notice.headline} ${notice.detail}`.toLowerCase()).not.toContain(
        "unexpected error"
      );
    }
  });
});

describe("the 30-day phone", () => {
  test("the retention verdict names the gateway's OWN window, not a copy of it", () => {
    const notice = rebootstrapNoticeFor("retention", {
      days: 30,
      maxEntries: 100_000,
    });
    expect(notice.detail).toContain("30 days");
    expect(notice.fullResync).toBe(true);
  });

  test("a gateway keeping a different window is described as it is", () => {
    const notice = rebootstrapNoticeFor("retention", {
      days: 7,
      maxEntries: 10_000,
    });
    expect(notice.detail).toContain("7 days");
    expect(notice.detail).not.toContain("30 days");
  });

  test("no retention facts means no invented number", () => {
    const notice = rebootstrapNoticeFor("retention");
    expect(notice.detail).not.toMatch(/\d/u);
  });

  // The queued-writes promise is the part a member actually needs: a full
  // re-sync must never read as "your unsent changes are gone". It lives in the
  // headline now (#883 W-F1), so it is asserted where the test's name always
  // said it was — checking only "whole library" left the promise itself
  // unpinned, and a rewrite could have dropped it silently.
  test("a full re-sync says the queued changes survive", () => {
    for (const verdict of VERDICTS) {
      const notice = rebootstrapNoticeFor(verdict);
      if (!notice.fullResync) continue;
      expect(notice.headline).toContain("whole library");
      expect(notice.headline).toContain("unsent changes stay queued");
    }
  });

  // One sentence per field, so neither half can quietly grow back into the
  // paragraph the U4 copy gate found here.
  test("every sentence stays short and single-thought", () => {
    for (const verdict of VERDICTS) {
      const notice = rebootstrapNoticeFor(verdict, {
        days: 30,
        maxEntries: 100_000,
      });
      for (const line of [notice.headline, notice.detail]) {
        expect(line.length, line).toBeLessThanOrEqual(120);
        expect(line.match(/[.!?](?=\s+\p{Lu})/gu), line).toBeNull();
      }
    }
  });

  test("ordinary machinery is not dressed up as a full re-sync", () => {
    expect(rebootstrapNoticeFor("initial").fullResync).toBe(false);
    expect(rebootstrapNoticeFor("shape-changed").fullResync).toBe(false);
  });
});

describe("reading the gateway frame", () => {
  test("a real frame becomes a notice", () => {
    const notice = rebootstrapNoticeFrom({
      error: "replica_rebootstrap_required",
      reason: "retention",
      retention: { days: 30, maxEntries: 100_000 },
    });
    expect(notice?.verdict).toBe("retention");
    expect(notice?.detail).toContain("30 days");
  });

  test("an unknown verdict produces NO notice rather than a made-up one", () => {
    expect(rebootstrapNoticeFrom({ reason: "something-new" })).toBeUndefined();
    expect(rebootstrapNoticeFrom({ reason: 7 })).toBeUndefined();
    expect(rebootstrapNoticeFrom(null)).toBeUndefined();
    expect(rebootstrapNoticeFrom("retention")).toBeUndefined();
  });

  test("a frame without retention facts still gets its reason's sentence", () => {
    const notice = rebootstrapNoticeFrom({ reason: "epoch-changed" });
    expect(notice?.fullResync).toBe(true);
  });

  test("isRebootstrapVerdict rejects anything off the closed set", () => {
    expect(isRebootstrapVerdict("retention")).toBe(true);
    expect(isRebootstrapVerdict("retention ")).toBe(false);
    expect(isRebootstrapVerdict(undefined)).toBe(false);
  });
});
