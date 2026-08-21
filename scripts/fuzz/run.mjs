/**
 * Fuzz lane runner (#839 G10).
 *
 * Deterministic, seeded, coverage-guided-lite mutation fuzzing over the
 * parsers that eat bytes somebody else chose. There is no fuzzing dependency
 * in this repo and none may be added, so the engine is the three files beside
 * this one: `mutate.mjs` (seeded PRNG + mutation table), `targets.mjs` (entry
 * points + invariants), and this runner.
 *
 * "Coverage-guided-lite": there is no coverage instrumentation. Feedback comes
 * from each target's *behaviour signature* — the outcome class it reports per
 * execution. An input that produces a signature never seen before is promoted
 * into the live corpus and mutated further, which is the same feedback shape a
 * coverage-guided fuzzer gets, at the granularity a target chooses to expose.
 *
 * Determinism is the point. Work is measured in iterations, never wall clock,
 * so two runs at the same seed execute the same inputs in the same order and
 * produce a byte-identical summary apart from timings. `--time-budget-ms` is a
 * runaway guard, not a schedule; when it trips the summary says so.
 *
 * Usage:
 *   node scripts/fuzz/run.mjs                    # full lane (nightly)
 *   node scripts/fuzz/run.mjs --smoke            # a few seconds per target
 *   node scripts/fuzz/run.mjs --target wal-keys --iterations 500000
 *   node scripts/fuzz/run.mjs --seed 839002      # a different program
 *   node scripts/fuzz/run.mjs --list
 *
 * Findings whose class is registered in `scripts/fuzz/known-findings.json` are
 * reported but do not fail the lane — they are recorded defects awaiting a
 * product decision, pinned byte-for-byte by `scripts/fuzz/replay.test.mjs`.
 * Anything else fails the run.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { createRng, mutate } from "./mutate.mjs";
import { FUZZ_TARGETS, FuzzInvariantError, targetById } from "./targets.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const fuzzDir = path.join(root, "scripts/fuzz");

/** Default program seed. Never `Date.now()` — a lane you cannot replay is noise. */
export const DEFAULT_SEED = 839_001;

/** Live-corpus ceiling. Bounds memory and keeps late iterations diverse. */
const MAX_LIVE_CORPUS = 512;

/** Findings recorded per target before the runner stops collecting. */
const MAX_FINDINGS_PER_TARGET = 16;

/**
 * Content address for a fuzz input — the crasher filename and the dedup key.
 * @param {Uint8Array} bytes Input bytes.
 * @returns {string} 16 hex characters of SHA-256.
 */
export function inputDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * Load the register of findings that are known, recorded, and not yet fixed.
 * @param {string} [file] Register path.
 * @returns {{ classes: Record<string, { issue: number; status: string; note: string }> }} Register.
 */
export function loadKnownFindings(
  file = path.join(fuzzDir, "known-findings.json")
) {
  if (!existsSync(file)) return { classes: {} };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return { classes: parsed.classes ?? {} };
}

/**
 * Read a target's committed seed corpus plus its committed crashers.
 * @param {string} targetId Target id.
 * @returns {{ bytes: Uint8Array; origin: string }[]} Corpus entries, name-sorted.
 */
export function loadCorpus(targetId) {
  const entries = [];
  for (const [dir, origin] of [
    [path.join(fuzzDir, "corpus", targetId), "seed"],
    [path.join(fuzzDir, "crashers", targetId), "crasher"],
  ]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (origin === "crasher") {
        if (!name.endsWith(".json")) continue;
        const record = JSON.parse(readFileSync(file, "utf8"));
        entries.push({
          bytes: Buffer.from(record.inputBase64, "base64"),
          origin: `crasher:${name}`,
        });
        continue;
      }
      entries.push({ bytes: readFileSync(file), origin: `seed:${name}` });
    }
  }
  if (entries.length === 0)
    entries.push({ bytes: Buffer.alloc(0), origin: "empty" });
  return entries;
}

/**
 * Classify a thrown value into a finding.
 * @param {unknown} error Thrown value.
 * @returns {{ className: string; kind: string; message: string }} Finding identity.
 */
function classify(error) {
  if (error instanceof FuzzInvariantError) {
    return {
      className: error.className,
      kind: "invariant",
      message: error.message,
    };
  }
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return { className: `uncaught.${name}`, kind: "uncaught", message };
}

/**
 * Fuzz one target for a fixed number of executions.
 * @param {import('./targets.mjs').FuzzTarget} target Target to fuzz.
 * @param {object} options Run options.
 * @param {number} options.seed Program seed.
 * @param {number} options.iterations Executions to perform.
 * @param {number} options.timeBudgetMs Runaway guard.
 * @returns {Promise<object>} Summary row for this target.
 */
export async function fuzzTarget(target, { seed, iterations, timeBudgetMs }) {
  const run = await target.load();
  const corpus = loadCorpus(target.id);
  const live = corpus.map((entry) => entry.bytes);
  const rng = createRng(seed ^ (target.id.length * 0x9e_37_79_b1));
  const signatures = new Set();
  /** @type {Map<string, object>} */
  const findings = new Map();
  const strategyCounts = {};
  let executions = 0;
  let truncated = false;
  const startedAt = performance.now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    // The committed corpus runs unmutated first: a seed input that already
    // violates an invariant must be reported before any mutation happens.
    const seeded = iteration < corpus.length;
    const strategy = seeded ? "corpus" : null;
    const input = seeded
      ? corpus[iteration].bytes
      : mutate({
          bytes: live[rng.int(live.length)],
          other: live[rng.int(live.length)],
          rng,
          dictionary: target.dictionary,
          structure: target.structure,
        });
    const bytes = seeded ? input : input.bytes;
    const usedStrategy = strategy ?? input.strategy;
    strategyCounts[usedStrategy] = (strategyCounts[usedStrategy] ?? 0) + 1;
    executions += 1;

    let signature = null;
    try {
      signature = run(bytes);
    } catch (error) {
      const finding = classify(error);
      if (!findings.has(finding.className)) {
        findings.set(finding.className, {
          ...finding,
          target: target.id,
          seed,
          iteration,
          strategy: usedStrategy,
          origin: seeded ? corpus[iteration].origin : "mutation",
          inputBase64: Buffer.from(bytes).toString("base64"),
          inputDigest: inputDigest(bytes),
        });
      }
      if (findings.size >= MAX_FINDINGS_PER_TARGET) break;
      continue;
    }

    // Coverage-guided-lite: a new behaviour signature earns the input a place
    // in the live corpus, so the next mutations start from somewhere new.
    if (!signatures.has(signature)) {
      signatures.add(signature);
      if (live.length < MAX_LIVE_CORPUS) live.push(bytes);
    }

    if (iteration % 512 === 0 && performance.now() - startedAt > timeBudgetMs) {
      truncated = true;
      break;
    }
  }

  const elapsedMs = performance.now() - startedAt;
  return {
    id: target.id,
    title: target.title,
    entry: target.entry,
    seed,
    requestedIterations: iterations,
    executions,
    corpusSeeds: corpus.length,
    signatures: signatures.size,
    liveCorpus: live.length,
    truncated,
    strategies: Object.fromEntries(Object.entries(strategyCounts).sort()),
    findings: [...findings.values()].sort((a, b) =>
      a.className.localeCompare(b.className)
    ),
    elapsedMs,
    execPerSecond:
      elapsedMs > 0 ? Math.round(executions / (elapsedMs / 1000)) : 0,
  };
}

/**
 * Persist a finding as a committed crasher (deterministic filename).
 * @param {object} finding Finding record.
 * @param {string} baseDir Crashers root.
 */
function writeCrasher(finding, baseDir) {
  const dir = path.join(baseDir, finding.target);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${finding.className}.json`);
  const record = {
    target: finding.target,
    class: finding.className,
    kind: finding.kind,
    message: finding.message,
    seed: finding.seed,
    strategy: finding.strategy,
    inputBase64: finding.inputBase64,
    inputDigest: finding.inputDigest,
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (existsSync(file) && readFileSync(file, "utf8") === serialized) return;
  writeFileSync(file, serialized);
}

/**
 * Build the artifact consumed by the nightly report, mirroring
 * `artifacts/mutation/scores.json`.
 * @param {object[]} rows Per-target summaries.
 * @param {object} meta Run metadata.
 * @returns {object} Artifact payload.
 */
export function buildFuzzArtifact(rows, meta) {
  return {
    generatedAt: new Date().toISOString(),
    lane: "fuzz",
    seed: meta.seed,
    mode: meta.mode,
    targets: rows,
  };
}

/**
 * Split findings into known (registered) and new (lane-failing).
 * @param {object[]} rows Per-target summaries.
 * @param {{ classes: Record<string, unknown> }} known Register.
 * @returns {{ known: object[]; fresh: object[] }} Partition.
 */
export function partitionFindings(rows, known) {
  const all = rows.flatMap((row) => row.findings);
  return {
    known: all.filter((finding) => finding.className in known.classes),
    fresh: all.filter((finding) => !(finding.className in known.classes)),
  };
}

/**
 * @param {string[]} argv Raw CLI arguments.
 * @returns {object} Parsed options.
 */
export function parseArgs(argv) {
  const out = {
    seed: DEFAULT_SEED,
    smoke: false,
    targets: [],
    iterations: null,
    timeBudgetMs: 180_000,
    writeCrashers: true,
    list: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--seed" && argv[index + 1])
      out.seed = Number(argv[++index]) >>> 0;
    else if (arg === "--smoke") out.smoke = true;
    else if (arg === "--target" && argv[index + 1])
      out.targets.push(argv[++index]);
    else if (arg === "--iterations" && argv[index + 1])
      out.iterations = Number(argv[++index]);
    else if (arg === "--time-budget-ms" && argv[index + 1])
      out.timeBudgetMs = Number(argv[++index]);
    else if (arg === "--no-write-crashers") out.writeCrashers = false;
    else if (arg === "--list") out.list = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

/**
 * `packages/client` ships no compiled JS, so its source `.ts` is imported
 * directly. Parameter properties in that tree need Node's transform mode,
 * which is a startup flag — so re-exec once with it rather than asking every
 * caller to remember. Node's own `process.features.typescript` is the probe.
 * @param {string[]} argv Arguments to forward.
 * @returns {boolean} True when the process re-execed (caller must stop).
 */
function reexecWithTypeTransform(argv) {
  if (process.features.typescript === "transform") return false;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      import.meta.filename,
      ...argv,
    ],
    { cwd: root, stdio: "inherit" }
  );
  process.exitCode = result.status ?? 1;
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node scripts/fuzz/run.mjs [--smoke] [--seed N] [--target <id>]… [--iterations N] [--time-budget-ms N] [--no-write-crashers] [--list]"
    );
    return;
  }
  if (args.list) {
    for (const target of FUZZ_TARGETS)
      console.log(`${target.id}\t${target.entry}\t${target.title}`);
    return;
  }
  if (reexecWithTypeTransform(argv)) return;

  const ids = new Set(FUZZ_TARGETS.map((target) => target.id));
  const unknown = args.targets.filter((id) => !ids.has(id));
  if (unknown.length) {
    console.error(
      `fuzz: unknown target(s) ${unknown.join(", ")} — known ids: ${[...ids].join(", ")}`
    );
    process.exitCode = 1;
    return;
  }
  const targets = args.targets.length
    ? args.targets.map(targetById)
    : FUZZ_TARGETS;
  const mode = args.smoke ? "smoke" : "full";
  console.log(
    `fuzz: seed ${args.seed}, mode ${mode}, ${targets.length} target(s)`
  );

  const rows = [];
  for (const target of targets) {
    const iterations =
      args.iterations ??
      (args.smoke ? target.smokeIterations : target.iterations);
    // oxlint-disable-next-line no-await-in-loop -- targets run in a fixed order and one at a time; concurrency would interleave their memory pressure and destroy the "same seed, same program" guarantee
    const row = await fuzzTarget(target, {
      seed: args.seed,
      iterations,
      timeBudgetMs: args.timeBudgetMs,
    });
    rows.push(row);
    console.log(
      `  - ${row.id}: ${row.executions} exec (${row.execPerSecond}/s), ` +
        `${row.signatures} signature(s), ${row.findings.length} finding(s)` +
        `${row.truncated ? " [time-budget truncated]" : ""}`
    );
  }

  const known = loadKnownFindings();
  const { known: recorded, fresh } = partitionFindings(rows, known);
  const artifactDir = path.join(root, "artifacts/fuzz");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    path.join(artifactDir, "summary.json"),
    `${JSON.stringify(buildFuzzArtifact(rows, { seed: args.seed, mode }), null, 2)}\n`
  );
  console.log("fuzz: wrote artifacts/fuzz/summary.json");

  if (args.writeCrashers) {
    for (const finding of [...recorded, ...fresh]) {
      writeCrasher(finding, path.join(fuzzDir, "crashers"));
      writeCrasher(finding, path.join(artifactDir, "crashers"));
    }
  }

  for (const finding of recorded) {
    const entry = known.classes[finding.className];
    console.log(
      `fuzz: known finding ${finding.className} (issue #${entry.issue}, ${entry.status}) — ${finding.message}`
    );
  }
  for (const finding of fresh) {
    console.error(
      `fuzz: NEW finding ${finding.className} in ${finding.target} at iteration ${finding.iteration} (seed ${finding.seed}) — ${finding.message}`
    );
    console.error(`fuzz:   input base64: ${finding.inputBase64}`);
  }
  if (fresh.length) {
    console.error(
      `fuzz: ${fresh.length} new finding(s). Commit the crasher under scripts/fuzz/crashers/, pin it in scripts/fuzz/replay.test.mjs, and register the class in scripts/fuzz/known-findings.json with its issue.`
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `fuzz: no new findings (${recorded.length} known finding(s) reproduced)`
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  await main();
}
