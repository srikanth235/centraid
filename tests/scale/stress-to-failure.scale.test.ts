import { glob } from "node:fs/promises";
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
import { journeyCeiling } from "../helpers/journeys.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

/**
 * STRESS TO FAILURE (issue #842 W4.2).
 *
 * Every other perf and scale rig in this repo asks "does the product stay
 * inside its budget?". This one asks the question that only matters after the
 * answer is no: WHAT HAPPENS WHEN IT DOESN'T. A budget tells an owner nothing
 * about the day their phone uploads a year of photos while three devices sync;
 * what tells them something is whether the gateway sheds that load with a named
 * refusal, keeps their data intact, and comes back when the surge passes.
 *
 * So this rig deliberately pushes past the knee and asserts on the SHAPE of the
 * failure, not on its absence:
 *
 *   1. GRACEFUL — every non-2xx under overload is a TYPED product refusal
 *      (`503 GATEWAY_BUSY` from the app-handler admission gate in
 *      `packages/server/src/engine/handlers/worker-admission.ts`, or a `429`
 *      from a rate gate). A 500, a socket hangup, or an untyped body is a
 *      failure of this rig — those are the shapes a client cannot act on.
 *   2. INTACT — a write storm at the far side of the knee leaves EXACTLY as
 *      many notes in the vault as there were 2xx responses. Not more (a
 *      refusal that half-committed), not fewer (a success that did not land),
 *      and `PRAGMA integrity_check` still says ok.
 *   3. NOT WEDGED, AND RECOVERS — when the load drops, one ordinary request
 *      succeeds again inside an owner-scale latency.
 *   4. THE KNEE IS FOUND — the rig walks a concurrency ladder and reports the
 *      first rung that refuses. If the ladder tops out with no refusal at all,
 *      that is a FAILURE of the rig, not a pass: it means the ladder never
 *      reached the knee it exists to locate, and the run proved nothing.
 *
 * Determinism: the ladder, the payloads and the op counts are fixed constants
 * and seeded strings. The only thing read from the clock is elapsed time.
 */
const OWNER = "tests/scale/stress-to-failure.scale.test.ts";

/**
 * The concurrency ladder. Doubling, because the knee is set by a small integer
 * (`WORKER_MAX_CONCURRENT`, 2 on a constrained host and 8 on a standard one)
 * plus a fixed queue depth (`WORKER_MAX_QUEUE`, 16) — a doubling ladder brackets
 * that within one rung on either kind of host, and 128 is comfortably past the
 * widest configuration the resolver will produce (32 + 16).
 */
const LADDER = [1, 2, 4, 8, 16, 32, 64, 128] as const;

/** Concurrent create-note calls in the data-integrity storm, past the knee. */
const WRITE_STORM = 64;

/** Statuses the product is allowed to shed load with. Anything else is a bug. */
const REFUSAL_STATUSES = new Set([429, 503]);

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

/** The gateway's own vault.db, found under the data dir it was given. */
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
    const ceilingRecoveryMs = journeyCeiling(
      "gateway/stress-recovery/empty/ci-linux-x64-4c",
      "stressRecovery",
      "ceilingRecoveryMs"
    );

    const gateway = await bootCompositeGateway("stress-to-failure-");
    onTestFinished(() => gateway.close());

    // ── 1. The ladder ────────────────────────────────────────────────────
    // Notes `library` is a declared app QUERY: a real app-engine worker
    // spawn, which is the subsystem that owns the admission gate. A route
    // that never spawns a worker would never reach a knee at all.
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

    // ── 2. The write storm, past the knee ────────────────────────────────
    // Fired at WRITE_STORM concurrency so a large fraction is refused. The
    // invariant is arithmetic, not statistical: notes in the vault must
    // equal 2xx responses EXACTLY.
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

    // ── 3. Recovery ──────────────────────────────────────────────────────
    // Every burst above has settled (each `burst` awaits all its requests),
    // so this is the first request after the load drops. No sleep: the rig
    // waits on the events, not on the clock.
    const recovery = await callOnce(
      gateway,
      "/centraid/notes/queries/library",
      {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ input: {} }),
      }
    );

    // ── 4. Integrity ─────────────────────────────────────────────────────
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
