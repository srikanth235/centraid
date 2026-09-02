#!/usr/bin/env node
// The bundle's runner (#915 Wave 4). `scripts/ci/gate-classes.test.mjs` owns
// the membership contract; this file owns the behaviour that makes bundling
// safe to do at all: every gate runs even after one fails, and a failing
// gate's own output is reproduced verbatim under its own name.
import assert from "node:assert/strict";
import test from "node:test";

import { HYGIENE_GATES, issueBody, summarize } from "./hygiene-lane.mjs";
import { runGates } from "./lint-product.mjs";

/** A fake gate runner: names ending in `-red` fail, everything else passes. */
const fakeRun = (name) =>
  Promise.resolve({
    name,
    code: name.endsWith("-red") ? 1 : 0,
    ms: 10,
    out: `output of ${name}`,
  });

test("every gate runs even after one fails, and all failures are reported", async () => {
  let out = "";
  const { results, failed } = await runGates(["a-red", "b", "c-red", "d"], {
    jobs: 2,
    run: fakeRun,
    write: (s) => {
      out += s;
    },
  });
  assert.equal(results.length, 4);
  assert.deepEqual(failed.sort(), ["a-red", "c-red"]);
  assert.match(out, /Failed: .*a-red/u);
  assert.match(out, /Failed: .*c-red/u);
});

test("a failing gate's buffered output is printed under its own name", async () => {
  let out = "";
  await runGates(["only-red"], {
    jobs: 1,
    run: fakeRun,
    write: (s) => {
      out += s;
    },
  });
  assert.match(out, /✗ only-red/u);
  assert.match(out, /output of only-red/u);
});

test("a passing gate's output is buffered away", async () => {
  let out = "";
  await runGates(["quiet"], {
    jobs: 1,
    run: fakeRun,
    write: (s) => {
      out += s;
    },
  });
  assert.doesNotMatch(out, /output of quiet/u);
  assert.match(out, /1\/1 gates passed/u);
});

test("an empty gate list is a pass, not a hang", async () => {
  const { results, failed } = await runGates([], {
    run: fakeRun,
    write: () => {},
  });
  assert.deepEqual(results, []);
  assert.deepEqual(failed, []);
});

test("the hygiene summary names every gate and every red one", () => {
  const summary = summarize(
    [
      { name: "test:env-red", code: 1, ms: 600 },
      { name: "lint:type-floor", code: 0, ms: 170 },
    ],
    "2026-09-05T05:00:00Z"
  );
  assert.equal(summary.verdict, "failed");
  assert.deepEqual(summary.red, ["test:env-red"]);
  assert.equal(summary.gates.length, 2);
  assert.equal(summary.rung, 5);
});

test("a clean hygiene run reports passed with no red gates", () => {
  const summary = summarize(
    [{ name: "test:env-red", code: 0, ms: 600 }],
    "2026-09-05T05:00:00Z"
  );
  assert.equal(summary.verdict, "passed");
  assert.deepEqual(summary.red, []);
});

test("the rolling issue body names the red gates and how to reproduce them", () => {
  const summary = summarize(
    [{ name: "test:comment-density", code: 1, ms: 10200 }],
    "2026-09-05T05:00:00Z"
  );
  const body = issueBody(summary, "https://example.invalid/run/1");
  assert.match(body, /bun run test:comment-density/u);
  assert.match(body, /https:\/\/example\.invalid\/run\/1/u);
  assert.match(body, /never the ledger/u);
});

test("the weekly membership is the seven ratchets #915 names", () => {
  assert.deepEqual([...HYGIENE_GATES].sort(), [
    "lint:schema-export",
    "lint:type-floor",
    "test:comment-density",
    "test:env-red",
    "test:hygiene-ratchet",
    "test:skip-inventory",
    "test:sleep-inventory",
  ]);
});
