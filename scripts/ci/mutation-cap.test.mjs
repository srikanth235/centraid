import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CAP_MS,
  DEFER_MARKER,
  casesFor,
  deferComment,
  findMarkedCommentId,
  resolveCapMs,
} from "./mutation-cap.mjs";

test("the cap defaults to eight minutes and the env overrides it", () => {
  assert.equal(resolveCapMs({}, {}), DEFAULT_CAP_MS);
  assert.equal(DEFAULT_CAP_MS, 480_000);
  assert.equal(resolveCapMs({}, { MUTATION_PR_CAP_MS: "60000" }), 60_000);
  assert.equal(
    resolveCapMs({ cap: "1000" }, { MUTATION_PR_CAP_MS: "60000" }),
    1000
  );
});

test("a zero or unparseable cap is an error, never a silent uncapped run", () => {
  assert.throws(
    () => resolveCapMs({}, { MUTATION_PR_CAP_MS: "0" }),
    /positive/u
  );
  assert.throws(
    () => resolveCapMs({}, { MUTATION_PR_CAP_MS: "-5" }),
    /positive/u
  );
  assert.throws(
    () => resolveCapMs({}, { MUTATION_PR_CAP_MS: "soon" }),
    /positive/u
  );
});

test("a capped run records a `deferred` case rather than a pass it did not earn", () => {
  const cases = casesFor({
    capped: true,
    exitCode: 143,
    durationMs: 481_000,
  });
  assert.deepEqual(cases, [
    { id: "deferred", verdict: "skipped", durationMs: 481_000, attempts: 1 },
  ]);
});

test("an uncapped run records the real verdict of the seeds", () => {
  assert.equal(
    casesFor({
      capped: false,
      exitCode: 0,
      durationMs: 1200,
      capMs: 480_000,
    })[0].verdict,
    "passed"
  );
  assert.equal(
    casesFor({
      capped: false,
      exitCode: 1,
      durationMs: 1200,
      capMs: 480_000,
    })[0].verdict,
    "failed"
  );
});

test("the deferral comment carries the dedupe marker and both numbers", () => {
  const body = deferComment({
    capMs: 480_000,
    durationMs: 495_000,
    runUrl: "https://example.test/run/9",
  });
  assert.ok(body.startsWith(DEFER_MARKER));
  assert.match(body, /480s/u);
  assert.match(body, /495s/u);
  assert.match(body, /mutation-full/u);
  assert.match(body, /https:\/\/example\.test\/run\/9/u);
});

test("findMarkedCommentId reads an id and refuses anything else", () => {
  assert.equal(findMarkedCommentId("12345\n"), "12345");
  assert.equal(findMarkedCommentId(""), null);
  assert.equal(findMarkedCommentId("null"), null);
  assert.equal(findMarkedCommentId("[]"), null);
});
