import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { forEachSequentially } from "@centraid/test-kit/sequential";

import {
  bootCompositeGateway,
  callOnce,
  percentile,
} from "../helpers/composite-workload.js";
import type {
  CompositeGateway,
  OpOutcome,
} from "../helpers/composite-workload.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/stress-to-failure.scale.test.ts";

const LADDER = [1, 2, 4, 8, 16, 32, 64, 128] as const;

const WRITE_STORM = 64;

const REFUSAL_STATUSES = new Set([429, 503]);

interface CeilingFile {
  metrics: {
    stressRecovery: { ceilingRecoveryMs: number };
  };
}

interface Rung {
  concurrency: number;
  ok: number;
  refusals: Record<string, number>;
  untyped: number;
  wrongStatus: Record<string, number>;
  transportErrors: string[];
  p95Ms: number;
}

async function burst(
  gateway: CompositeGateway,
  concurrency: number,
  operation: (index: number) => Promise<OpOutcome>
): Promise<Rung> {
  const outcomes = await Promise.all(
    Array.from({ length: concurrency }, (_, index) => operation(index))
  );
  const rung: Rung = {
    concurrency,
    ok: 0,
    refusals: {},
    untyped: 0,
    wrongStatus: {},
    transportErrors: [],
    p95Ms: percentile(
      outcomes.map((outcome) => outcome.durationMs),
      0.95
    ),
  };
  for (const outcome of outcomes) {
    if (outcome.transportError !== null) {
      rung.transportErrors.push(outcome.transportError);
      continue;
    }
    if (outcome.status >= 200 && outcome.status < 300) {
      rung.ok += 1;
      continue;
    }
    const key = `${outcome.status}/${outcome.code ?? "untyped"}`;
    rung.refusals[key] = (rung.refusals[key] ?? 0) + 1;
    if (!REFUSAL_STATUSES.has(outcome.status))
      rung.wrongStatus[key] = (rung.wrongStatus[key] ?? 0) + 1;
    if (outcome.code === null) rung.untyped += 1;
  }
  return rung;
}

async function vaultDbPath(vaultDir: string): Promise<string> {
  const found: string[] = [];
  for await (const entry of glob("*/vault.db", { cwd: vaultDir }))
    found.push(path.join(vaultDir, entry));
  if (found.length !== 1)
    throw new Error(
      `expected exactly one vault.db under ${vaultDir}, found ${found.length}`
    );
  return found[0]!;
}

describe("stress-to-failure.scale", () => {
  test("past the knee the gateway refuses by name, keeps the vault intact, and recovers", async () => {
    const ceilings = JSON.parse(
      await readFile("tests/experience-budgets/gateway.json", "utf8")
    ) as CeilingFile;
    const ceilingRecoveryMs = ceilings.metrics.stressRecovery.ceilingRecoveryMs;

    const gateway = await bootCompositeGateway("stress-to-failure-");
    onTestFinished(() => gateway.close());

    const started = performance.now();
    const rungs: Rung[] = [];
    await forEachSequentially([...LADDER], async (concurrency) => {
      rungs.push(
        await burst(gateway, concurrency, async () =>
          callOnce(gateway, "/centraid/notes/queries/library", {
            method: "POST",
            contentType: "application/json",
            body: JSON.stringify({ input: {} }),
          })
        )
      );
    });
    const ladderMs = performance.now() - started;
    const knee = rungs.find((rung) => Object.keys(rung.refusals).length > 0);

    const storm = await burst(gateway, WRITE_STORM, async (index) =>
      callOnce(gateway, "/centraid/notes/actions/create-note", {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({
          input: {
            title: `Stress note ${index}`,
            body_text: `stress body ${index} deterministic`,
          },
        }),
      })
    );

    const recovery = await callOnce(
      gateway,
      "/centraid/notes/queries/library",
      {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ input: {} }),
      }
    );

    const dbPath = await vaultDbPath(gateway.vaultDir);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const noteRows = (
      db.prepare("SELECT count(*) AS n FROM knowledge_note").get() as {
        n: number;
      }
    ).n;
    const integrity = db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check: string }
      | undefined;
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    db.close();

    const allRungs = [...rungs, storm];
    const untypedTotal = allRungs.reduce(
      (total, rung) => total + rung.untyped,
      0
    );
    const wrongStatus = allRungs.flatMap((rung) =>
      Object.keys(rung.wrongStatus)
    );
    const transportErrors = allRungs.flatMap((rung) => rung.transportErrors);
    const refusalTally: Record<string, number> = {};
    for (const rung of allRungs)
      for (const [key, count] of Object.entries(rung.refusals))
        refusalTally[key] = (refusalTally[key] ?? 0) + count;

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const withinDrift = drift === null || ladderMs <= drift;
    const recovered =
      recovery.status >= 200 &&
      recovery.status < 300 &&
      recovery.durationMs <= ceilingRecoveryMs;
    const passed =
      knee !== undefined &&
      untypedTotal === 0 &&
      wrongStatus.length === 0 &&
      transportErrors.length === 0 &&
      noteRows === storm.ok &&
      integrity?.integrity_check === "ok" &&
      foreignKeys.length === 0 &&
      recovered &&
      withinDrift;

    console.log("\n========== STRESS TO FAILURE ==========");
    for (const rung of rungs)
      console.log(
        `concurrency ${String(rung.concurrency).padStart(3)}: ` +
          `${String(rung.ok).padStart(3)} ok, p95 ${rung.p95Ms.toFixed(0).padStart(5)} ms, ` +
          `refusals ${JSON.stringify(rung.refusals)}`
      );
    console.log(
      `KNEE: ${knee === undefined ? "NOT REACHED" : `first refusal at concurrency ${knee.concurrency}`}`
    );
    console.log(
      `write storm (${WRITE_STORM} concurrent create-note): ${storm.ok} ok, ` +
        `refusals ${JSON.stringify(storm.refusals)}`
    );
    console.log(`notes in vault: ${noteRows} (must equal ${storm.ok})`);
    console.log(
      `recovery after load drop: ${recovery.status} in ${recovery.durationMs.toFixed(0)} ms ` +
        `(ceiling ${ceilingRecoveryMs} ms)`
    );
    console.log(`integrity_check: ${integrity?.integrity_check}`);
    console.log("=======================================\n");

    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name:
        `Stress to failure: concurrency ladder ${LADDER.join("/")} on the ` +
        `app-handler plane + a ${WRITE_STORM}-wide write storm`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "ladder wall clock",
          value: ladderMs,
          unit: "ms",
          ...(drift === null ? {} : { budget: drift }),
        },
        {
          name: "knee (first refusing concurrency)",
          value: knee?.concurrency ?? 0,
          unit: "count",
        },
        {
          name: "recovery after load drop",
          value: recovery.durationMs,
          unit: "ms",
          budget: ceilingRecoveryMs,
        },
        { name: "untyped refusals", value: untypedTotal, unit: "count" },
        {
          name: "refusals outside 429/503",
          value: wrongStatus.length,
          unit: "count",
        },
        { name: "write storm accepted", value: storm.ok, unit: "count" },
        { name: "notes committed", value: noteRows, unit: "rows" },
        ...rungs.map((rung) => ({
          name: `p95 at concurrency ${rung.concurrency}`,
          value: rung.p95Ms,
          unit: "ms",
        })),
      ],
    });

    expect(
      transportErrors,
      "overload must never drop a connection — every request gets an HTTP response"
    ).toStrictEqual([]);
    expect(
      untypedTotal,
      `every refusal under overload must carry a product error code; ${untypedTotal} untyped: ${JSON.stringify(refusalTally)}`
    ).toBe(0);
    expect(
      wrongStatus,
      `overload may only be shed with 429 or 503; saw ${wrongStatus.join(", ")}`
    ).toStrictEqual([]);
    expect(
      knee,
      `the ladder topped out at concurrency ${LADDER.at(-1)} with no refusal at all — ` +
        "this run located no knee and proves nothing; widen LADDER"
    ).toBeDefined();
    expect(
      noteRows,
      `data integrity: ${storm.ok} create-note calls were accepted but the vault holds ${noteRows} notes — ` +
        "a refused write must leave nothing behind and an accepted one must land"
    ).toBe(storm.ok);
    expect(integrity?.integrity_check).toBe("ok");
    expect(foreignKeys).toStrictEqual([]);
    expect(
      recovered,
      `recovery: the first request after the load dropped returned ${recovery.status} in ` +
        `${recovery.durationMs.toFixed(0)} ms (ceiling ${ceilingRecoveryMs} ms)`
    ).toBe(true);
    expect(
      withinDrift,
      `sustained drift: ${ladderMs} ms vs drift budget ${drift} ms (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
  }, 300_000);
});
