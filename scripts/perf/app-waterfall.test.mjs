import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareToBaseline,
  FIRST_PAINT,
  renderWaterfall,
} from "./app-waterfall.mjs";

const run = (app, durationMs, statements) => ({ app, durationMs, statements });

test("all eight bundled apps have a first-paint query", () => {
  assert.equal(FIRST_PAINT.length, 8);
  assert.deepEqual(
    FIRST_PAINT.map((entry) => entry.app),
    ["agenda", "docs", "locker", "notes", "people", "photos", "tally", "tasks"]
  );
});

test("a first run has no baseline and says so rather than inventing one", () => {
  const rows = compareToBaseline([run("photos", 200, 141)], null, 20);
  assert.equal(rows[0].verdict, "new");
  assert.equal(rows[0].deltaMs, null);
});

test("a wall-clock move inside the tolerance is not news", () => {
  const rows = compareToBaseline(
    [run("photos", 215, 141)],
    { rows: [run("photos", 200, 141)] },
    20
  );
  assert.equal(rows[0].verdict, "same");
});

test("a wall-clock move past the tolerance is", () => {
  const rows = compareToBaseline(
    [run("photos", 260, 141)],
    { rows: [run("photos", 200, 141)] },
    20
  );
  assert.equal(rows[0].verdict, "slower");
});

test("a CHANGED statement count outranks the clock — it is deterministic", () => {
  const rows = compareToBaseline(
    [run("photos", 201, 142)],
    { rows: [run("photos", 200, 141)] },
    20
  );
  assert.equal(rows[0].verdict, "work changed");
  assert.equal(rows[0].deltaStatements, 1);
});

test("the table names the app, its clock, its statements and the delta", () => {
  const rendered = renderWaterfall(
    compareToBaseline(
      [run("photos", 260, 141)],
      { rows: [run("photos", 200, 141)] },
      20
    )
  );
  assert.match(rendered, /photos/u);
  assert.match(rendered, /141/u);
  assert.match(rendered, /\+60\.0ms/u);
  assert.match(rendered, /slower/u);
});
