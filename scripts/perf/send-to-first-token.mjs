/**
 * Gateway send → first token dead-time probe (issue #842 W0.5).
 *
 * `sendToFirstToken` is the single most-felt latency in the product, and until
 * now the journey ledger carried it as `unmeasured` with
 * the honest note that no rig existed: every path in
 * `tests/perf/harness-turn.perf.test.ts` measures DISPATCH throughput (2,000
 * registry dispatches against a stubbed `runTurn`), which never spawns a
 * harness, never speaks ACP, and therefore cannot see the interval this
 * budget is about.
 *
 * WHAT THIS MEASURES, EXACTLY — read this before trusting the number:
 *
 *   t0  `runAcpTurn(...)` is called (the gateway's equivalent of "send")
 *   t1  the first `assistant.delta` event reaches `onEvent` (first token)
 *
 * Between them sit harness process spawn, the ACP `initialize` handshake,
 * `session/new`, `session/prompt` dispatch, and the stream translation in
 * `packages/server/src/acp/backends/acp/backend.ts`. The provider is held
 * CONSTANT by driving the scripted `fake-acp-harness.mjs` in `--mode=normal`,
 * which streams its first chunk with no artificial think time — so the
 * measurement is dead time the repo owns and nothing else.
 *
 * WHAT IT DOES NOT MEASURE, and why the budget entry says so:
 *   - the HTTP/SSE conversation route in front of `runAcpTurn`
 *   - any client: no renderer, no frame, no composer
 *   - a real provider's own time to first token (deliberately excluded — that
 *     is the provider's number, not a regression this repo can fix)
 *
 * So this is a LOWER BOUND on what the vault owner feels, and it fences a
 * gateway-side regression (a slower spawn, an extra handshake round trip, a
 * blocking step added before the prompt goes out) rather than the whole
 * perceived interval. The remaining span is named in the budget entry's
 * `probe` field so nobody reads this as the complete answer.
 *
 * The ceiling lives in `tests/journeys.json` and is
 * tighten-only via `PERF_BUDGET_SOURCES`
 * (`scripts/test-report/ratchet-floors.mjs`), so widening it is a reviewed
 * edit with a recorded `approvedDeviation`, never a quiet one.
 *
 * Usage:
 *   node scripts/perf/send-to-first-token.mjs             # enforce the ceiling
 *   node scripts/perf/send-to-first-token.mjs --report    # print, never fail
 *   node scripts/perf/send-to-first-token.mjs --samples 40 --warmup 5
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { journeyMetric } from "../lib/journey-ledger.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const HARNESS_PATH = path.join(
  root,
  "packages/server/src/acp/backends/acp/fake-acp-harness.mjs"
);

/**
 * @param {string[]} argv Raw argv slice.
 * @returns {{ samples: number, warmup: number, report: boolean }} Options.
 */
export function parseArgs(argv) {
  const out = { samples: 25, warmup: 3, report: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--samples" && argv[i + 1]) out.samples = Number(argv[++i]);
    else if (argv[i] === "--warmup" && argv[i + 1])
      out.warmup = Number(argv[++i]);
    else if (argv[i] === "--report") out.report = true;
  }
  return out;
}

/**
 * Percentile of a sample set, nearest-rank on the sorted values.
 *
 * Nearest-rank rather than interpolation because these are wall-clock samples
 * from a small n: an interpolated p95 invents a value no run produced, and a
 * budget seeded from an invented value is exactly what this family of files
 * exists to prevent.
 *
 * @param {number[]} values Unsorted samples.
 * @param {number} p Percentile in [0, 1].
 * @returns {number} The sample at that rank.
 */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Summarize a sample set the way the budget entry records it.
 * @param {number[]} values Samples in ms.
 * @returns {{ n: number, minMs: number, medianMs: number, p95Ms: number, maxMs: number }} Summary.
 */
export function summarize(values) {
  return {
    n: values.length,
    minMs: Math.min(...values),
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

/**
 * Compare a measured p95 against the surface's ceiling.
 * @param {number} p95Ms Measured p95.
 * @param {unknown} metric The `sendToFirstToken` budget entry.
 * @returns {{ ok: boolean, message: string }} Verdict.
 */
export function compareToCeiling(p95Ms, metric) {
  const entry = /** @type {Record<string, unknown>} */ (metric ?? {});
  const ceiling = Number(entry.ceilingP95Ms);
  if (!Number.isFinite(ceiling) || ceiling <= 0)
    return {
      ok: false,
      message:
        "send-to-first-token: tests/journeys.json gateway/own-echo has no positive `sendToFirstToken.ceilingP95Ms`. A probe that runs against no ceiling is not a gate — seed one from a real run (see this file's header) rather than deleting the step.",
    };
  return {
    ok: p95Ms <= ceiling,
    message:
      p95Ms <= ceiling
        ? `send-to-first-token: p95 ${p95Ms.toFixed(1)}ms of ${ceiling}ms ceiling`
        : `send-to-first-token: p95 ${p95Ms.toFixed(1)}ms exceeds the ${ceiling}ms ceiling. Find what was added between the send and the first token, or widen \`ceilingP95Ms\` on gateway/own-echo in tests/journeys.json with an \`approvedDeviation\` saying what the extra dead time buys.`,
  };
}

/**
 * One end-to-end sample: call `runAcpTurn` and stop the clock on the first
 * assistant token.
 * @param {(input: unknown, config: unknown) => Promise<unknown>} runAcpTurn Turn driver.
 * @returns {Promise<number>} Milliseconds from send to first token.
 */
async function sample(runAcpTurn) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "send-to-first-token-"));
  const controller = new AbortController();
  /** @type {number | null} */
  let firstTokenMs = null;
  const started = performance.now();
  await runAcpTurn(
    {
      cwd,
      message: "hello",
      extraSystemPrompt: "",
      abortSignal: controller.signal,
      /** @param {{ type?: string }} event Normalized stream event. */
      onEvent: (event) => {
        if (firstTokenMs === null && event?.type === "assistant.delta")
          firstTokenMs = performance.now() - started;
      },
    },
    {
      kind: "acp",
      acpArgs: [],
      binPath: HARNESS_PATH,
      extraArgs: ["--mode=normal"],
      permissionPolicy: "auto-allow",
    }
  );
  if (firstTokenMs === null)
    throw new Error(
      "send-to-first-token: the turn completed without ever emitting an `assistant.delta` — the fixture or the stream translation changed, and a missing measurement must not read as a fast one"
    );
  return firstTokenMs;
}

/**
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { runAcpTurn } = await import("@centraid/server/acp");
  const driver = /** @type {(i: unknown, c: unknown) => Promise<unknown>} */ (
    /** @type {unknown} */ (runAcpTurn)
  );

  // Both passes are STRICTLY SERIAL, and the reduce-over-a-promise-chain
  // idiom (the same one tests/perf/harness-turn.perf.test.ts uses) is how
  // that is expressed without an await inside a loop. Serial is the
  // measurement, not an oversight: N harness processes spawned at once on a
  // 4-cpu host would measure contention between the samples rather than the
  // gateway's dead time, which is the one thing this probe exists to see.
  //
  // Warmups are discarded, not averaged in: the first turns pay module
  // resolution and a cold page cache, which is real cost but not the steady
  // state a regression would move.
  await Array.from({ length: args.warmup }).reduce(async (previous) => {
    await previous;
    await sample(driver);
  }, Promise.resolve());

  /** @type {number[]} */
  const values = [];
  await Array.from({ length: args.samples }).reduce(async (previous) => {
    await previous;
    values.push(await sample(driver));
  }, Promise.resolve());
  const stats = summarize(values);

  const line = `send-to-first-token: n=${stats.n} min=${stats.minMs.toFixed(1)}ms median=${stats.medianMs.toFixed(1)}ms p95=${stats.p95Ms.toFixed(1)}ms max=${stats.maxMs.toFixed(1)}ms (host ${process.platform} ${process.arch}, ${os.cpus().length} cpus)`;

  if (args.report) {
    console.log(line);
    return 0;
  }

  const verdict = compareToCeiling(
    stats.p95Ms,
    journeyMetric("gateway/own-echo/none/ci-linux-x64-4c", "sendToFirstToken")
  );
  console.log(line);
  console[verdict.ok ? "log" : "error"](verdict.message);
  return verdict.ok ? 0 : 1;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) process.exitCode = await main();
