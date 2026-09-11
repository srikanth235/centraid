/* oxlint-disable vitest/no-import-node-test -- (#1018) node --test lane, not a vitest suite */
/* oxlint-disable vitest/prefer-importing-vitest-globals -- (#1018) node --test lane, not a vitest suite */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  compareAll,
  compareScenario,
  explainFailures,
  renderRows,
  verdict,
} from "./work-counter-gate.ts";
import type { ScenarioExpectation } from "./work-counter-gate.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const counters = (
  over: Record<string, number> = {}
): Record<string, number> => ({
  statements: 6,
  rowsScanned: 24,
  fsyncs: 1,
  bytesRead: 2100,
  bytesWritten: 198,
  workerSpawns: 0,
  httpRoundTrips: 0,
  invalidations: 0,
  reReads: 0,
  ...over,
});

const expected: ScenarioExpectation = {
  counters: {
    statements: { mode: "max", value: 6 },
    fsyncs: { mode: "exact", value: 1 },
  },
};

test("a value at the ceiling passes; one above it fails", () => {
  assert.equal(verdict(compareScenario("read", expected, counters())), 0);
  assert.equal(
    verdict(compareScenario("read", expected, counters({ statements: 7 }))),
    1
  );
});

test("max lets a value improve; exact does not let one drift either way", () => {
  assert.equal(
    verdict(compareScenario("read", expected, counters({ statements: 3 }))),
    0
  );
  assert.equal(
    verdict(compareScenario("read", expected, counters({ fsyncs: 0 }))),
    1,
    "a durability barrier that vanished is a bug, not a speed-up"
  );
});

test("counters the expectation does not name are ignored", () => {
  const rows = compareScenario("read", expected, counters({ bytesRead: 1e9 }));
  assert.deepEqual(
    rows.map((row) => row.counter),
    ["statements", "fsyncs"]
  );
});

test("the failure message names the counter and the direction", () => {
  const rows = compareScenario("read", expected, counters({ statements: 9 }));
  const message = explainFailures(rows);
  assert.match(message, /statements must be at most 6, measured 9 \(\+3\)/u);
  assert.match(message, /do not raise the number/u);
  assert.equal(
    explainFailures(compareScenario("read", expected, counters())),
    ""
  );
});

test("a scenario in the file but not in the run is an error, not a pass", () => {
  assert.throws(
    () => compareAll({ scenarios: { read: expected } }, {}),
    /drifted apart/u
  );
});

test("a scenario measured but not expected is an error, not a silent pass", () => {
  assert.throws(
    () => compareAll({ scenarios: {} }, { read: counters() }),
    /have no expectation/u
  );
});

test("an unknown mode is rejected rather than treated as a budget", () => {
  assert.throws(
    () =>
      compareScenario(
        "read",
        { counters: { statements: { mode: "roughly", value: 6 } } },
        counters()
      ),
    /unknown mode/u
  );
});

test("a non-integer measurement is rejected", () => {
  assert.throws(
    () => compareScenario("read", expected, counters({ statements: 6.5 })),
    /non-negative integer/u
  );
});

test("the table marks failures rather than omitting them", () => {
  const table = renderRows(
    compareScenario("read", expected, counters({ statements: 7 }))
  );
  assert.match(table, /statements\s+max\s+6\s+7\s+FAIL/u);
  assert.match(table, /fsyncs .*ok/u);
});

test("the committed expectations file parses and names only known modes", () => {
  const file: unknown = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "work-counters.expected.json"),
      "utf8"
    )
  );
  if (!isRecord(file) || !isRecord(file.scenarios)) {
    throw new Error("work-counters.expected.json missing scenarios");
  }
  const scenarios = Object.entries(file.scenarios);
  assert.ok(scenarios.length > 0, "the gate must fence at least one path");
  for (const [name, scenario] of scenarios) {
    if (!isRecord(scenario) || !isRecord(scenario.counters)) {
      throw new Error(`${name} has no counters object`);
    }
    for (const [counter, spec] of Object.entries(scenario.counters)) {
      if (!isRecord(spec)) {
        throw new Error(`${name}.${counter} is not an object`);
      }
      assert.ok(
        spec.mode === "exact" || spec.mode === "max",
        `${name}.${counter} has mode ${String(spec.mode)}`
      );
      assert.ok(
        Number.isSafeInteger(spec.value) &&
          typeof spec.value === "number" &&
          spec.value >= 0,
        `${name}.${counter} must be a non-negative integer`
      );
    }
  }
});
