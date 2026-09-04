#!/usr/bin/env node
/*
 * WHICH CANDIDATE MADE IT SLOW (#927).
 *
 * Every promotion publishes its paired-journey baseline beside the candidate
 * record on gh-pages, so the record of a journey's cost is a LIST OF PROMOTED
 * TREES in order, not a time series of nightly runs on whatever runner was
 * free. That difference is what makes this a bisect at all: each entry is
 * attributable to exactly one merge.
 *
 * The walk finds the FIRST candidate at which the journey's median crossed the
 * step threshold and stayed there — not merely the largest single jump, which
 * on a noisy series is usually one bad runner. A step that reverts inside the
 * confirmation window is reported as a blip rather than a culprit, because
 * calling a reverted spike a regression sends someone to read an innocent diff.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Promotions must be walked in order; the record carries its own timestamp. */
export function readSeries(historyDir, journeyKey) {
  const files = readdirSync(historyDir).filter(
    (name) => name.endsWith(".json") && name !== "latest.json"
  );
  const points = [];
  for (const name of files) {
    const report = JSON.parse(
      readFileSync(path.join(historyDir, name), "utf8")
    );
    const row = (report.rows ?? []).find(
      (candidate) => `${candidate.key}#${candidate.metric}` === journeyKey
    );
    if (!row) continue;
    points.push({
      sha: path.basename(name, ".json"),
      at: report.generatedAt,
      deltaMs: row.deltaMs,
      verdict: row.verdict,
      toleranceMs: row.toleranceMs,
    });
  }
  return points.sort((left, right) =>
    String(left.at).localeCompare(String(right.at))
  );
}

/**
 * The first promotion whose paired delta cleared the tolerance and STAYED
 * cleared for `confirm` further promotions.
 * @param {ReturnType<typeof readSeries>} series Ordered promotions.
 * @param {number} [confirm] How many later promotions must agree.
 * @returns {{ culprit: object | null, blips: object[] }} The verdict.
 */
export function firstSustainedStep(series, confirm = 2) {
  const blips = [];
  for (let index = 0; index < series.length; index += 1) {
    const point = series[index];
    if (point.deltaMs <= point.toleranceMs) continue;
    const window = series.slice(index + 1, index + 1 + confirm);
    if (
      window.length === confirm &&
      window.every((p) => p.deltaMs > p.toleranceMs)
    )
      return { culprit: point, blips };
    if (window.length < confirm) return { culprit: point, blips };
    blips.push(point);
  }
  return { culprit: null, blips };
}

function parseArgs(argv) {
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : argv[index + 1];
  };
  return {
    journey: read("--journey", ""),
    history: read("--history", ""),
    output: read("--output", ""),
    confirm: Number(read("--confirm", "2")),
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.journey || !args.history) {
    console.error(
      "usage: bisect-journeys.mjs --journey 'key#metric' --history <dir> [--output FILE] [--confirm N]"
    );
    return 2;
  }
  const series = readSeries(args.history, args.journey);
  if (series.length === 0) {
    console.error(
      `bisect-journeys: no promotion in ${args.history} carries a baseline for ${args.journey}`
    );
    return 1;
  }
  const { culprit, blips } = firstSustainedStep(series, args.confirm);
  for (const point of series)
    console.log(
      `${point.sha.slice(0, 9)}  ${String(point.at).slice(0, 19)}  ${point.deltaMs.toFixed(1)}ms  (tol ${point.toleranceMs.toFixed(1)}ms)  ${point.verdict}`
    );
  if (culprit)
    console.log(
      `\nbisect-journeys: ${args.journey} first cleared its tolerance at ${culprit.sha} (${culprit.deltaMs.toFixed(1)} ms over ${culprit.toleranceMs.toFixed(1)} ms) and stayed there`
    );
  else
    console.log(
      `\nbisect-journeys: ${args.journey} never cleared its tolerance for ${args.confirm} consecutive promotions${blips.length > 0 ? `; ${blips.length} single-promotion blip(s) seen and not blamed` : ""}`
    );
  if (args.output) {
    mkdirSync(path.dirname(args.output), { recursive: true });
    writeFileSync(
      args.output,
      `${JSON.stringify({ journey: args.journey, series, culprit, blips }, null, 2)}\n`
    );
  }
  return 0;
}

if (process.argv[1] === import.meta.filename)
  process.exitCode = main(process.argv.slice(2));
