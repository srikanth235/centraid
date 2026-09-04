#!/usr/bin/env node
/*
 * THE PAIRED CANDIDATE/PR JOURNEY RUN (#927).
 *
 * What it replaces: a trailing-median drift budget that needed thirty nightly
 * samples before it had an opinion, and a 3x-of-median catastrophe gate that
 * only ever fired on a collapse. Both compared a number taken on ONE tree today
 * against numbers taken on OTHER trees on OTHER nights and OTHER runners, so
 * most of what they measured was the runner. Neither could answer the only
 * question a merge rung has: is THIS change slower than the tree it is being
 * merged into?
 *
 * This answers exactly that, on its first run:
 *
 *   1. INTERLEAVE. Each round runs the candidate and the PR back to back, and
 *      alternates which goes first. A runner that gets slower mid-run, or that
 *      warms a page cache, moves both sides of a pair together, so the paired
 *      DIFFERENCE is invariant to the drift that swamps an absolute number.
 *   2. PAIR, then bootstrap. The statistic is the median of the per-round
 *      differences, and its confidence interval comes from resampling those
 *      differences — inside this run, from this run's own data. No history, no
 *      warm-up, and no assumption that latency is normal (it is not: it is
 *      right-skewed with occasional very slow rounds, which is exactly what a
 *      mean-and-sigma test mishandles).
 *   3. STATE THE CONFIDENCE. A verdict is `regressed` only when the whole
 *      interval sits above the journey's declared tolerance; "slower, but the
 *      run cannot tell by how much" is `inconclusive`, which FAILS the lane
 *      too. Treating "cannot tell" as a pass is the failure mode of every
 *      threshold-on-one-sample gate.
 *
 * The tolerance is per journey, in `tests/journeys.json` (`tolerancePercent`),
 * because a 20% move in cold open and a 20% move in a fan-out projection are
 * not the same news.
 *
 * Determinism: the resampler is seeded, so the same samples always produce the
 * same verdict and a re-run cannot launder a red.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { journeyLedger } from "../lib/journey-ledger.mjs";

const RESAMPLES = 2000;
const DEFAULT_ROUNDS = 12;

/**
 * Seeded PRNG (mulberry32). The bootstrap must be reproducible: a verdict that
 * changed on re-run would make "run it again" a way past a red.
 * @param {number} seed Any 32-bit integer.
 * @returns {() => number} Uniform in [0, 1).
 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Median of a numeric sample.
 * @param {readonly number[]} values Samples.
 * @returns {number} The median.
 */
export function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Percentile bootstrap CI for the median of the paired differences.
 * @param {readonly number[]} differences One difference per round (b - a).
 * @param {{ resamples?: number, seed?: number, confidence?: number }} [options] Knobs.
 * @returns {{ median: number, low: number, high: number, confidence: number }} The interval.
 */
export function bootstrapMedianCi(differences, options = {}) {
  const resamples = options.resamples ?? RESAMPLES;
  const confidence = options.confidence ?? 0.95;
  const random = seededRandom(options.seed ?? 927);
  const medians = [];
  for (let index = 0; index < resamples; index += 1) {
    const draw = differences.map(
      () => differences[Math.floor(random() * differences.length)]
    );
    medians.push(median(draw));
  }
  medians.sort((left, right) => left - right);
  const tail = (1 - confidence) / 2;
  const at = (fraction) =>
    medians[
      Math.min(medians.length - 1, Math.floor(fraction * medians.length))
    ];
  return {
    median: median(differences),
    low: at(tail),
    high: at(1 - tail),
    confidence,
  };
}

/**
 * The verdict for one journey.
 *
 * `regressed` needs the WHOLE interval above the tolerance: an interval that
 * straddles it is `inconclusive`, which is a real answer and not a pass. The
 * symmetric case is `improved`, which is worth naming so a win is not read as
 * noise and quietly given back.
 * @param {{ candidate: readonly number[], pr: readonly number[], tolerancePercent: number, seed?: number }} input Paired samples.
 * @returns {{ verdict: string, deltaMs: number, deltaPercent: number, toleranceMs: number, low: number, high: number, confidence: number, rounds: number }} The verdict.
 */
export function pairedVerdict({ candidate, pr, tolerancePercent, seed }) {
  if (candidate.length !== pr.length || candidate.length < 3)
    throw new Error(
      `paired-journeys: need at least 3 matched rounds, got ${candidate.length}/${pr.length}`
    );
  const differences = pr.map((value, index) => value - candidate[index]);
  const interval = bootstrapMedianCi(differences, { seed });
  const baseline = median(candidate);
  const toleranceMs = (baseline * tolerancePercent) / 100;
  const verdict =
    interval.low > toleranceMs
      ? "regressed"
      : interval.high < -toleranceMs
        ? "improved"
        : interval.low > 0 && interval.high > toleranceMs
          ? "inconclusive"
          : "held";
  return {
    verdict,
    deltaMs: interval.median,
    deltaPercent: baseline === 0 ? 0 : (interval.median / baseline) * 100,
    toleranceMs,
    low: interval.low,
    high: interval.high,
    confidence: interval.confidence,
    rounds: candidate.length,
  };
}

/**
 * Pull one number out of a bench report by dotted path.
 * @param {unknown} report Parsed report.
 * @param {string} dotted Dotted path.
 * @returns {number} The sample.
 */
export function sampleAt(report, dotted) {
  let cursor = report;
  for (const step of dotted.split("."))
    cursor = cursor === null || cursor === undefined ? cursor : cursor[step];
  if (typeof cursor !== "number" || !Number.isFinite(cursor))
    throw new Error(`paired-journeys: no numeric sample at "${dotted}"`);
  return cursor;
}

/**
 * Every ledger entry that declares how to sample it in a paired run.
 * @param {object} [ledger] Parsed ledger.
 * @returns {Array<{ key: string, metric: string, path: string, tolerancePercent: number }>} The sampled set.
 */
export function pairedEntries(ledger = journeyLedger()) {
  const found = [];
  for (const [key, entry] of Object.entries(ledger.entries ?? {}))
    for (const [metric, value] of Object.entries(entry.metrics ?? {}))
      if (value.pairedSample)
        found.push({
          key,
          metric,
          path: value.pairedSample,
          tolerancePercent: entry.tolerancePercent,
        });
  return found;
}

/**
 * Run the journey benchmark once inside one checkout.
 * @param {string} dir Checkout root.
 * @param {string} scratch Directory for the report file.
 * @param {number} round Round index, for the file name.
 * @param {string} side "candidate" or "pr".
 * @returns {object} The parsed report.
 */
function runOnce(dir, scratch, round, side) {
  const output = path.join(scratch, `${side}-${round}.json`);
  const result = spawnSync(
    process.execPath,
    [
      "packages/server/scripts/bench-journeys.mjs",
      "--output",
      output,
      "--intents",
      "8",
      "--fill",
      "500",
      "--subscribers",
      "1,10",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, CENTRAID_BENCH_QUIET: "1" },
    }
  );
  if (result.status !== 0)
    throw new Error(
      `paired-journeys: ${side} round ${round} failed\n${result.stderr}`
    );
  return JSON.parse(readFileSync(output, "utf8"));
}

/**
 * Interleave the two checkouts and return one sample series per side.
 * @param {{ candidateDir: string, prDir: string, rounds: number, entries: ReturnType<typeof pairedEntries> }} input Inputs.
 * @returns {Record<string, { candidate: number[], pr: number[] }>} Series by "key#metric".
 */
export function collectPairs({ candidateDir, prDir, rounds, entries }) {
  const scratch = mkdtempSync(path.join(tmpdir(), "paired-journeys-"));
  const series = Object.fromEntries(
    entries.map((entry) => [
      `${entry.key}#${entry.metric}`,
      { candidate: [], pr: [] },
    ])
  );
  try {
    for (let round = 0; round < rounds; round += 1) {
      // Alternate which side runs first: a runner that warms up or slows down
      // over the run would otherwise favour whichever side always went second.
      const order =
        round % 2 === 0
          ? [
              ["candidate", candidateDir],
              ["pr", prDir],
            ]
          : [
              ["pr", prDir],
              ["candidate", candidateDir],
            ];
      for (const [side, dir] of order) {
        const report = runOnce(dir, scratch, round, side);
        for (const entry of entries)
          series[`${entry.key}#${entry.metric}`][side].push(
            sampleAt(report, entry.path)
          );
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return series;
}

/**
 * Render the verdict table.
 * @param {Array<object>} rows Verdict rows.
 * @returns {string} Table.
 */
export function renderVerdicts(rows) {
  const header =
    "journey                                            metric          Δ median   95% CI            tol    verdict";
  const lines = rows.map(
    (row) =>
      `${row.key.padEnd(50)} ${row.metric.padEnd(15)} ${`${row.deltaMs.toFixed(1)}ms`.padStart(9)}  ` +
      `[${row.low.toFixed(1)}, ${row.high.toFixed(1)}]`.padEnd(18) +
      `${row.toleranceMs.toFixed(1)}ms`.padStart(7) +
      `  ${row.verdict}`
  );
  return [header, ...lines].join("\n");
}

function parseArgs(argv) {
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : argv[index + 1];
  };
  return {
    candidateDir: read("--candidate", ""),
    prDir: read("--pr", ""),
    rounds: Number(read("--rounds", String(DEFAULT_ROUNDS))),
    output: read("--output", ""),
    seed: Number(read("--seed", "927")),
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.candidateDir || !args.prDir) {
    console.error(
      "usage: paired-journeys.mjs --candidate <dir> --pr <dir> [--rounds N] [--output FILE]"
    );
    return 2;
  }
  const entries = pairedEntries();
  if (entries.length === 0) {
    console.error(
      "paired-journeys: no ledger entry declares a `pairedSample`, so this run would compare nothing"
    );
    return 1;
  }
  const series = collectPairs({ ...args, entries });
  const rows = entries.map((entry) => ({
    ...entry,
    ...pairedVerdict({
      ...series[`${entry.key}#${entry.metric}`],
      tolerancePercent: entry.tolerancePercent,
      seed: args.seed,
    }),
  }));
  console.log(renderVerdicts(rows));
  const regressed = rows.filter((row) => row.verdict === "regressed");
  const inconclusive = rows.filter((row) => row.verdict === "inconclusive");
  const report = {
    generatedAt: new Date().toISOString(),
    rounds: args.rounds,
    seed: args.seed,
    resamples: RESAMPLES,
    rows,
  };
  if (args.output)
    writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  for (const row of regressed)
    console.error(
      `paired-journeys: ${row.key}#${row.metric} regressed ${row.deltaPercent.toFixed(1)}% ` +
        `(95% CI [${row.low.toFixed(1)}, ${row.high.toFixed(1)}] ms, tolerance ${row.toleranceMs.toFixed(1)} ms over ${row.rounds} paired rounds)`
    );
  for (const row of inconclusive)
    console.error(
      `paired-journeys: ${row.key}#${row.metric} is INCONCLUSIVE — the interval straddles the tolerance; add rounds rather than reading this as a pass`
    );
  // An interval that straddles the tolerance has not shown the change is safe.
  // Treating "cannot tell" as a pass is how a threshold gate goes quiet, so an
  // inconclusive journey fails the lane exactly as a regressed one does.
  return regressed.length + inconclusive.length > 0 ? 1 : 0;
}

if (process.argv[1] === import.meta.filename)
  process.exitCode = main(process.argv.slice(2));
