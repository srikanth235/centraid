// AGENDA'S PARITY FIXTURE'S EMITTER AND ITS ORACLE, in one file (#1020, wave 4
// slot 4d, D-1020-D3-6).
//
// This is the one permitted kind of edit to the pinned v0 tree: a fixture
// adapter under `tests/**` that makes a v0 suite read `contracts/` files
// (#1020, Execution plan → Invariants). It adds no product code and changes no
// v0 behaviour.
//
// TWO JOBS, ONE COMMAND. With `CENTRAID_WRITE_CONTRACTS=1` it WRITES the three
// files under `contracts/apps/agenda/`; without it, it rebuilds the bundle from
// the live v0 tree and asserts equality with what is committed:
//
//     CENTRAID_WRITE_CONTRACTS=1 node node_modules/vitest/vitest.mjs run \
//       tests/quality/agenda-parity.contract.test.ts
//     bun run format && git diff --exit-code contracts/apps/agenda

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENDA_PARITY_DIR,
  AGENDA_PARITY_FILES,
  buildAgendaParity,
  payloadsFor,
} from "../../contracts/tools/export-agenda-parity.js";

const ROOT = path.join(import.meta.dirname, "..", "..");
const WRITE = process.env.CENTRAID_WRITE_CONTRACTS === "1";

describe("contracts/apps/agenda", () => {
  it("is what the v0 Agenda handlers answer", async () => {
    const bundle = await buildAgendaParity();
    const payloads = payloadsFor(bundle);
    for (const file of AGENDA_PARITY_FILES) {
      const target = path.join(ROOT, AGENDA_PARITY_DIR, file);
      if (WRITE) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, payloads[file]);
        continue;
      }
      const committed: unknown = JSON.parse(readFileSync(target, "utf8"));
      expect(
        JSON.parse(payloads[file]),
        `${AGENDA_PARITY_DIR}/${file} is stale — re-run with CENTRAID_WRITE_CONTRACTS=1`
      ).toStrictEqual(committed);
    }
  });

  // The bundle's own shape, asserted so a silently empty fixture cannot pass
  // the equality check above by being equally empty on both sides.
  it("carries a recurring series expanded across a DST boundary", async () => {
    const bundle = await buildAgendaParity();
    const dst = bundle.queries.find(
      (entry) =>
        entry.query === "upcoming" &&
        (entry.input as { from?: string }).from ===
          "2026-03-01T00:00:00.000Z" &&
        (entry.input as { to?: string }).to === "2026-03-20T00:00:00.000Z"
    );
    expect(dst, "the DST window case is in the fixture").toBeDefined();
    const events = (dst!.output as { events: Record<string, unknown>[] })
      .events;
    const occurrences = events.filter(
      (event) => typeof event["original_start_local"] === "string"
    );
    expect(occurrences.length).toBeGreaterThan(5);
    // THE WALL CLOCK SURVIVES THE OFFSET CHANGE: every occurrence of the 09:00
    // series is at 09:00 local, and the instants straddle the transition.
    const walls = new Set(
      occurrences
        .filter((event) => event["summary"] === "Standup")
        .map((event) => String(event["original_start_local"]).slice(11))
    );
    expect([...walls]).toStrictEqual(["09:00:00"]);
    const instants = new Set(
      occurrences
        .filter((event) => event["summary"] === "Standup")
        .map((event) => String(event["dtstart"]).slice(11, 16))
    );
    expect(instants.size).toBeGreaterThan(1);
    // The skip removed its occurrence, and the override moved one.
    const keys = occurrences.map((event) => event["original_start_local"]);
    expect(keys).not.toContain("2026-03-10T09:00:00");

    // Every one of the four queries is exercised.
    expect(new Set(bundle.queries.map((entry) => entry.query))).toStrictEqual(
      new Set(["upcoming", "search", "day-context", "parties"])
    );
    // The script carries its refusals: a fixture of only happy paths proves
    // the easy half.
    const refusals = bundle.commands.filter(
      (step) => step.status !== "executed"
    );
    expect(refusals.length).toBeGreaterThanOrEqual(8);
  });
});
