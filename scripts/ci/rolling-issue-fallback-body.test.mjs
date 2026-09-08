import assert from "node:assert/strict";
import test from "node:test";

import { parkFor, renderFallbackBody } from "./rolling-issue-fallback-body.mjs";

test("parkFor reads the first ledger that names the lane", () => {
  const lanes = [
    { lanes: { "mobile-e2e-ios": { issue: 870, expires: "2026-09-16" } } },
    { lanes: { "mobile-e2e-ios": { issue: 1, expires: "2030-01-01" } } },
  ];
  assert.equal(parkFor(lanes, "mobile-e2e-ios").issue, 870);
  assert.equal(parkFor(lanes, "web-e2e"), null);
  assert.equal(parkFor([], "web-e2e"), null);
  assert.equal(parkFor([{}], "web-e2e"), null);
});

test("an unparked lane renders as red with its run link", () => {
  const body = renderFallbackBody({
    lane: "web-e2e",
    rung: 4,
    result: "failure",
    runUrl: "https://example.test/run/1",
    today: "2026-09-02",
    park: null,
  });
  assert.match(body, /`web-e2e` is red on rung 4/u);
  assert.match(body, /\| Park \| not parked \|/u);
  assert.match(body, /https:\/\/example\.test\/run\/1/u);
});

test("an expired park says so instead of reading as a live park", () => {
  const body = renderFallbackBody({
    lane: "mobile-e2e-ios",
    rung: 4,
    result: "failure",
    runUrl: "u",
    today: "2026-10-01",
    park: { issue: 870, expires: "2026-09-16", why: "because" },
  });
  assert.match(body, /that date has passed/u);
  assert.match(body, /#870/u);
  assert.match(body, /because/u);
});

test("a live park renders its expiry without the expired warning", () => {
  const body = renderFallbackBody({
    lane: "mobile-e2e-ios",
    rung: 4,
    result: "failure",
    runUrl: "u",
    today: "2026-09-02",
    park: { issue: 870, expires: "2026-09-16" },
  });
  assert.match(body, /parked until 2026-09-16/u);
  assert.doesNotMatch(body, /that date has passed/u);
});
