// TASKS'S PARITY FIXTURE'S EMITTER AND ITS ORACLE, in one file (#1020, wave 4
// slot 4d, D-1020-D3-6).
//
// This is the one permitted kind of edit to the pinned v0 tree: a fixture
// adapter under `tests/**` that makes a v0 suite read `contracts/` files
// (#1020, Execution plan → Invariants). It adds no product code and changes no
// v0 behaviour.
//
// TWO JOBS, ONE COMMAND. With `CENTRAID_WRITE_CONTRACTS=1` it WRITES the three
// files under `contracts/apps/tasks/`; without it, it rebuilds the bundle from
// the live v0 tree and asserts equality with what is committed:
//
//     CENTRAID_WRITE_CONTRACTS=1 node node_modules/vitest/vitest.mjs run \
//       tests/quality/tasks-parity.contract.test.ts
//     bun run format && git diff --exit-code contracts/apps/tasks

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  TASKS_PARITY_DIR,
  TASKS_PARITY_FILES,
  buildTasksParity,
  payloadsFor,
} from "../../contracts/tools/export-tasks-parity.js";

const ROOT = path.join(import.meta.dirname, "..", "..");
const WRITE = process.env.CENTRAID_WRITE_CONTRACTS === "1";

describe("contracts/apps/tasks", () => {
  it("is what the v0 Tasks handlers answer", async () => {
    const bundle = await buildTasksParity();
    const payloads = payloadsFor(bundle);
    for (const file of TASKS_PARITY_FILES) {
      const target = path.join(ROOT, TASKS_PARITY_DIR, file);
      if (WRITE) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, payloads[file]);
        continue;
      }
      const committed: unknown = JSON.parse(readFileSync(target, "utf8"));
      expect(
        JSON.parse(payloads[file]),
        `${TASKS_PARITY_DIR}/${file} is stale — re-run with CENTRAID_WRITE_CONTRACTS=1`
      ).toStrictEqual(committed);
    }
  });

  // The bundle's own shape, asserted so a silently empty fixture cannot pass
  // the equality check above by being equally empty on both sides.
  it("carries the promotion rule, the clamp and the repeating task", async () => {
    const bundle = await buildTasksParity();
    const board = bundle.queries.find(
      (entry) =>
        entry.query === "board" && Object.keys(entry.input).length === 0
    );
    expect(board, "the default board case is in the fixture").toBeDefined();
    const answer = board!.output as {
      open: Record<string, unknown>[];
      logbook: Record<string, unknown>[];
      projects: unknown[];
      sections: unknown[];
      tags: unknown[];
      counts: { open: number; closed: number };
      truncated: boolean;
      window: number;
    };
    expect(answer.window).toBe(500);
    expect(answer.projects).toHaveLength(2);
    expect(answer.sections).toHaveLength(1);
    // THE PROMOTION RULE: the unfinished child of the completed "Tax return"
    // is a root of its own, and the completed parent is in the logbook.
    const openTitles = answer.open.map((task) => task["title"]);
    expect(openTitles).toContain("Find the receipts");
    expect(answer.logbook.map((task) => task["title"])).toContain("Tax return");
    // NULLS LAST: the undated task is not first.
    expect(openTitles[0]).not.toBe("Learn to make sourdough");
    // A REPEATING TASK CARRIES THE SENTENCE AND THE COLLAPSE, never the rule.
    const watering = answer.open.find(
      (task) => task["title"] === "Water the plants"
    );
    expect(watering?.["recurrence_summary"]).toBe("Daily");
    expect(typeof watering?.["missed"]).toBe("number");
    expect(typeof watering?.["next_due"]).toBe("string");

    // The declared floor and ceiling both clamp.
    const under = bundle.queries.find(
      (entry) =>
        entry.query === "board" &&
        (entry.input as { limit?: number }).limit === 1
    );
    expect((under!.output as { window: number }).window).toBe(20);
    const over = bundle.queries.find(
      (entry) =>
        entry.query === "board" &&
        (entry.input as { limit?: number }).limit === 9000
    );
    expect((over!.output as { window: number }).window).toBe(500);

    expect(new Set(bundle.queries.map((entry) => entry.query))).toStrictEqual(
      new Set(["board", "search"])
    );
    // The script carries its refusals: a fixture of only happy paths proves
    // the easy half.
    const refusals = bundle.commands.filter(
      (step) => step.status !== "executed"
    );
    expect(refusals.length).toBeGreaterThanOrEqual(5);
  });
});
