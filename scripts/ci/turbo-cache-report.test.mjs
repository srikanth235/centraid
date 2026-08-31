import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTask,
  renderReport,
  summarize,
  taskDurationMs,
} from "./turbo-cache-report.mjs";

test("classifyTask: turbo 2.x MISS", () => {
  assert.deepEqual(
    classifyTask({ cache: { local: false, remote: false, status: "MISS" } }),
    { status: "miss", source: "-" }
  );
});

test("classifyTask: a remote hit is attributed to the remote", () => {
  assert.deepEqual(
    classifyTask({ cache: { local: false, remote: true, status: "HIT" } }),
    { status: "hit", source: "remote" }
  );
});

test("classifyTask: a local hit is attributed to the local cache", () => {
  assert.deepEqual(
    classifyTask({ cache: { local: true, remote: false, status: "HIT" } }),
    { status: "hit", source: "local" }
  );
});

test("classifyTask: an unrecognised shape is unknown, never a hit", () => {
  // A cache report that rounds an unfamiliar summary toward "it worked" is
  // worse than no report — it answers the question wrongly and confidently.
  assert.equal(classifyTask({}).status, "unknown");
  assert.equal(
    classifyTask({ cache: { status: "SOMETHING-NEW" } }).status,
    "unknown"
  );
});

test("taskDurationMs: reads start/end, falls back to duration, never NaN", () => {
  assert.equal(taskDurationMs({ startTime: 100, endTime: 2_100 }), 2_000);
  assert.equal(taskDurationMs({ duration: 42 }), 42);
  assert.equal(taskDurationMs({ startTime: 500, endTime: 100 }), 0);
  assert.equal(taskDurationMs(undefined), 0);
});

test("summarize: hit rate is over classified tasks only", () => {
  const result = summarize({
    tasks: [
      {
        package: "a",
        task: "build",
        cache: { status: "HIT", local: true },
        execution: { startTime: 0, endTime: 10 },
      },
      {
        package: "b",
        task: "build",
        cache: { status: "MISS" },
        execution: { startTime: 0, endTime: 3_000 },
      },
      { package: "c", task: "build" },
    ],
  });
  assert.equal(result.total, 3);
  assert.equal(result.hits, 1);
  assert.equal(result.misses, 1);
  assert.equal(result.unknown, 1);
  // 1 hit out of 2 classified — the unknown row does not silently count either way.
  assert.equal(result.hitRate, 0.5);
  assert.equal(result.missMs, 3_000);
});

test("summarize: an empty run reports a zero rate rather than dividing by zero", () => {
  const result = summarize({ tasks: [] });
  assert.equal(result.hitRate, 0);
  assert.equal(result.total, 0);
});

test("renderReport: names the misses and surfaces the global hash inputs", () => {
  const report = renderReport(
    summarize({
      tasks: [
        {
          package: "@centraid/core",
          task: "build",
          cache: { status: "MISS" },
          execution: { startTime: 0, endTime: 1_000 },
        },
      ],
    }),
    { hashOfExternalDependencies: "abc" }
  );
  assert.match(report, /@centraid\/core#build/u);
  assert.match(report, /MISS/u);
  assert.match(report, /a change here misses EVERY task at once/u);
  assert.match(report, /hashOfExternalDependencies/u);
});
