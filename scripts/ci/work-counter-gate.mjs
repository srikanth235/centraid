#!/usr/bin/env node
/**
 * The per-PR perf gate's comparison (#927 P2).
 *
 * The merge rung asks ONE question — "did this change make the product do more
 * work?" — and answers it by comparing INTEGERS the product counts about
 * itself against expectations checked into this repository. That is why the
 * gate needs no retry step and no history: two runs of the same code on the
 * same fixture produce the same integers on any host, so a failure is a
 * regression and never a noisy sample. The wall-clock rig it replaced on this
 * rung could not say that, which is why it carried an automatic retry (#557).
 *
 * The comparison itself lives here rather than in the rig so it is unit-tested
 * (`work-counter-gate.test.mjs`) without booting a vault, and so the rig and a
 * developer reading `--explain` share one renderer.
 *
 * TIGHTEN-ONLY, like every other ceiling in this repo: `mode: "max"` counters
 * fail when the measured value EXCEEDS the expectation, and lowering an
 * expectation is a normal commit while raising one is the thing a reviewer must
 * see. `mode: "exact"` is for counters whose value is a fact about the code
 * path, not a budget — a hot read that suddenly runs a second statement is a
 * regression even though "more statements" is the only direction it can move.
 */

const MODES = new Set(["exact", "max"]);

/**
 * Compare one measured counter set against one expectation entry.
 * Returns a row per counter named in the expectation; counters the expectation
 * does not name are ignored, so adding a counter to the contract does not
 * break every gate the day it lands.
 */
export function compareScenario(name, expected, measured) {
  const rows = [];
  for (const [counter, spec] of Object.entries(expected.counters)) {
    const mode = spec.mode ?? "max";
    if (!MODES.has(mode)) {
      throw new Error(
        `${name}.${counter}: unknown mode ${JSON.stringify(mode)} (expected exact or max)`
      );
    }
    const actual = measured[counter];
    if (!Number.isSafeInteger(actual) || actual < 0) {
      throw new Error(
        `${name}.${counter}: measured value must be a non-negative integer, got ${String(actual)}`
      );
    }
    const ok = mode === "exact" ? actual === spec.value : actual <= spec.value;
    rows.push({
      scenario: name,
      counter,
      mode,
      expected: spec.value,
      actual,
      ok,
    });
  }
  return rows;
}

/** Every scenario in the expectations file, against a `{scenario: counters}` map. */
export function compareAll(expectations, measurements) {
  const rows = [];
  for (const [name, expected] of Object.entries(expectations.scenarios)) {
    const measured = measurements[name];
    if (!measured) {
      throw new Error(
        `work counters: scenario "${name}" is expected but was not measured — the rig and the expectations file have drifted apart`
      );
    }
    rows.push(...compareScenario(name, expected, measured));
  }
  const extra = Object.keys(measurements).filter(
    (name) => !(name in expectations.scenarios)
  );
  if (extra.length > 0) {
    throw new Error(
      `work counters: measured scenario(s) ${extra.join(", ")} have no expectation — add them to scripts/ci/work-counters.expected.json`
    );
  }
  return rows;
}

/** A fixed-width table; the failing rows are marked, not merely absent. */
export function renderRows(rows) {
  const header = ["scenario", "counter", "mode", "expected", "actual", ""];
  const body = rows.map((row) => [
    row.scenario,
    row.counter,
    row.mode,
    String(row.expected),
    String(row.actual),
    row.ok ? "ok" : "FAIL",
  ]);
  const widths = header.map((_cell, column) =>
    Math.max(
      header[column].length,
      ...body.map((cells) => cells[column].length)
    )
  );
  const line = (cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

/**
 * The message a failing gate prints. It names the counter and the direction,
 * because "the perf gate failed" without a counter is the report that made the
 * old rig un-actionable.
 */
export function explainFailures(rows) {
  return rows
    .filter((row) => !row.ok)
    .map(
      (row) =>
        `${row.scenario}: ${row.counter} ${row.mode === "exact" ? "is" : "must be at most"} ${row.expected}, measured ${row.actual} (+${row.actual - row.expected}). ` +
        `Something on this path now does more work. Find it — do not raise the number.`
    )
    .join("\n");
}

/** Exit code for a comparison: 0 when every row holds. */
export function verdict(rows) {
  return rows.every((row) => row.ok) ? 0 : 1;
}

// CLI: `node scripts/ci/work-counter-gate.mjs <measurements.json> [expectations.json]`
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
  const measurementsPath = process.argv[2];
  const expectationsPath = process.argv[3];
  if (measurementsPath) {
    const { readFileSync } = await import("node:fs");
    const { default: path } = await import("node:path");
    const expectations = JSON.parse(
      readFileSync(
        expectationsPath ??
          path.join(import.meta.dirname, "work-counters.expected.json"),
        "utf8"
      )
    );
    const measurements = JSON.parse(readFileSync(measurementsPath, "utf8"));
    const rows = compareAll(expectations, measurements);
    process.stdout.write(`${renderRows(rows)}\n`);
    const code = verdict(rows);
    if (code !== 0) process.stderr.write(`\n${explainFailures(rows)}\n`);
    process.exitCode = code;
  }
}
