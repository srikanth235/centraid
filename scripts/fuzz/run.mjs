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

export const DEFAULT_SEED = 839_001;

const MAX_LIVE_CORPUS = 512;

const MAX_FINDINGS_PER_TARGET = 16;

export function inputDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

export function loadKnownFindings(
  file = path.join(fuzzDir, "known-findings.json")
) {
  if (!existsSync(file)) return { classes: {} };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return { classes: parsed.classes ?? {} };
}

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

export async function fuzzTarget(target, { seed, iterations, timeBudgetMs }) {
  const run = await target.load();
  const corpus = loadCorpus(target.id);
  const live = corpus.map((entry) => entry.bytes);
  const rng = createRng(seed ^ (target.id.length * 0x9e_37_79_b1));
  const signatures = new Set();
  const findings = new Map();
  const strategyCounts = {};
  let executions = 0;
  let truncated = false;
  const startedAt = performance.now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
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

export function buildFuzzArtifact(rows, meta) {
  return {
    generatedAt: new Date().toISOString(),
    lane: "fuzz",
    seed: meta.seed,
    mode: meta.mode,
    targets: rows,
  };
}

export function partitionFindings(rows, known) {
  const all = rows.flatMap((row) => row.findings);
  return {
    known: all.filter((finding) => finding.className in known.classes),
    fresh: all.filter((finding) => !(finding.className in known.classes)),
  };
}

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
