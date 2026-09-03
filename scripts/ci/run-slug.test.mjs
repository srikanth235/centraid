import assert from "node:assert/strict";
import test from "node:test";

import { toRunDate, toSlug } from "./run-slug.mjs";

const NOW = new Date("2026-07-26T09:15:00Z");

test("takes the UTC date from the run created_at timestamp", () => {
  assert.equal(toRunDate("2026-07-20T06:00:11Z", NOW), "2026-07-20");
});

test("falls back to today when gh returned nothing", () => {
  assert.equal(toRunDate("", NOW), "2026-07-26");
  assert.equal(toRunDate(undefined, NOW), "2026-07-26");
  assert.equal(toRunDate(null, NOW), "2026-07-26");
});

test("falls back when gh returned an error string rather than a timestamp", () => {
  assert.equal(toRunDate("gh: Not Found (HTTP 404)", NOW), "2026-07-26");
});

test("rejects a well-shaped but impossible date", () => {
  assert.equal(toRunDate("2026-13-45T00:00:00Z", NOW), "2026-07-26");
  assert.equal(toRunDate("2026-02-30T00:00:00Z", NOW), "2026-07-26");
});

test("a run that started before midnight keeps its own date, not the publish date", () => {
  const publishedAfterMidnight = new Date("2026-07-27T00:20:00Z");
  assert.equal(
    toRunDate("2026-07-26T23:50:00Z", publishedAfterMidnight),
    "2026-07-26"
  );
});

test("slug pairs the date with the run id", () => {
  assert.equal(toSlug("2026-07-26", "17539821"), "2026-07-26-17539821");
});
