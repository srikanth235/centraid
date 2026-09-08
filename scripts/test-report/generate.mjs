/**
 * The nightly report generator — the CLI shell (#915 Wave 3).
 *
 * Everything of substance lives elsewhere: `collect.mjs` does the reading,
 * `read-model.mjs` turns it into a model with no I/O, and `render/` turns the
 * model into one self-contained HTML page. This file only wires them, so the
 * honesty suites and `report:smoke` can drive it against a fixture root and
 * the model and the renderer can each be tested on their own.
 *
 * Flags (all optional; every input renders honestly when absent):
 *   --evidence <dir>            tonight's lane evidence (artifacts/evidence)
 *   --evidence-previous <dir>   the previous night's, for the deltas
 *   --candidate <file>          artifacts/candidate.json
 *   --claims <file>             tests/claims.json
 *   --history <dir>             artifacts/report-history
 *   --output <dir>              dist/test-report
 *   --scope <nightly|main|pr>   what this run is allowed to claim
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadClaims } from "./claims-schema.mjs";
import {
  readCoverageFloors,
  readFieldObservations,
  readFuzz,
  readHistory,
  readInventory,
  readJsonAt,
  readMutation,
  readTrends,
} from "./collect.mjs";
import { deriveAll } from "./derive.mjs";
import { evidenceAgeMs, readEvidenceDir } from "./read-evidence.mjs";
import { buildModel } from "./read-model.mjs";
import { renderReport } from "./render/index.mjs";
import { writeSummarySidecars } from "./summary-markdown.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** `--flag value` pairs, with the repo-root defaults every lane relies on. */
export function parseFlags(argv, env = process.env) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    flags[argv[index].slice(2)] = argv[index + 1];
  }
  const at = (value, fallback) => path.resolve(ROOT, value ?? fallback);
  return {
    evidence: at(flags.evidence, "artifacts/evidence"),
    evidencePrevious: at(
      flags["evidence-previous"],
      "artifacts/evidence-previous"
    ),
    candidate: at(flags.candidate, "artifacts/candidate.json"),
    claims: at(flags.claims, "tests/claims.json"),
    history: at(flags.history, "artifacts/report-history"),
    output: at(flags.output, "dist/test-report"),
    coverage: at(flags.coverage, "coverage/coverage-summary.json"),
    mutation: at(flags.mutation, "artifacts/mutation/scores.json"),
    fuzz: at(flags.fuzz, "artifacts/fuzz/summary.json"),
    scope: flags.scope ?? env.TEST_REPORT_SCOPE ?? "pr",
    runSlug: env.TEST_REPORT_RUN_SLUG ?? null,
    publicUrl: env.TEST_REPORT_PUBLIC_URL ?? null,
    runUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
    repoUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`
        : null,
    runId: env.GITHUB_RUN_ID ?? null,
  };
}

/** Read every input and build the model. Exported so the smoke test can too. */
export async function collectModel(options, now = new Date()) {
  const { claims, errors: claimErrors } = loadClaims(options.claims);
  if (!claims)
    throw new Error(`claims file unreadable:\n  ${claimErrors.join("\n  ")}`);

  const tonight = readEvidenceDir(options.evidence);
  const previous = readEvidenceDir(options.evidencePrevious);
  const history = readHistory(options.history);
  const generatedAt = now.toISOString();
  const today = generatedAt.slice(0, 10);

  const coverage = readCoverageFloors({
    summaryFile: options.coverage,
    floorsFile: path.join(ROOT, "tests/floors.json"),
    history,
  });

  const model = buildModel({
    claims,
    derived: await deriveAll(claims),
    evidence: tonight.lanes,
    evidenceErrors: [
      ...claimErrors,
      ...tonight.errors,
      ...previous.errors.map((error) => `previous night: ${error}`),
    ],
    previousEvidence: previous.lanes,
    candidate: readJsonAt(options.candidate, null),
    history,
    generatedAt,
    run: {
      id: options.runId,
      url: options.runUrl,
      slug: options.runSlug,
      publicUrl: options.publicUrl,
    },
    scope: options.scope,
    quality: {
      coverageFloors: coverage.rows,
      ratchetCandidates: coverage.candidates,
      mutation: readMutation({
        scoresFile: options.mutation,
        floorsFile: path.join(ROOT, "tests/floors.json"),
      }),
      fuzz: readFuzz(options.fuzz),
      qualityOpen: readFieldObservations(path.join(ROOT, "QUALITY.md"), today),
      inventory: readInventory(ROOT),
      trends: readTrends(history),
    },
  });

  model.evidenceAgeMs = evidenceAgeMs(options.evidence, now);
  model.repoUrl = options.repoUrl;
  model.links = {
    previous: options.publicUrl ? `${options.publicUrl}runs/` : null,
    permalink: options.runSlug
      ? `test-report/nightly/runs/${options.runSlug}/`
      : null,
  };
  // §5 reads per-flow results out of tonight's cases, whichever lane wrote them.
  model.caseResults = new Map();
  for (const entry of tonight.lanes.values()) {
    for (const observed of entry.cases ?? [])
      model.caseResults.set(observed.id, observed);
  }
  return model;
}

/** The `summary.json` sidecar: the shape the job summary and release lane read. */
export function buildSummary(model) {
  return {
    schema: 1,
    verdict: model.verdict.verdict,
    why: model.verdict.why,
    flip: model.verdict.flip,
    blockers: model.blockers,
    deltas: {
      passed: model.counts.passed ?? 0,
      failed: model.counts.failed ?? 0,
      degraded: model.counts.degraded ?? 0,
      noEvidence: model.counts["no-evidence"] ?? 0,
      newRed: model.delta.newRed,
      newGreen: model.delta.newGreen,
      previousVerdict: model.delta.previousVerdict,
    },
    parks: model.evidencePanels.parks,
    candidate: model.candidate?.sha ?? null,
    generatedAt: model.generatedAt,
    label: model.night,
    validationErrorCount: model.validationErrors.length,
    // The durable-history whitelist reads these back; a night before #915
    // carries none of them and reads as null rather than as zero.
    lanes: Object.fromEntries(
      model.lanes.map((row) => [
        row.lane,
        { verdict: row.verdict, durationMs: row.durationMs },
      ])
    ),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const options = parseFlags(process.argv.slice(2));
  const model = await collectModel(options);
  await mkdir(options.output, { recursive: true });
  await writeFile(
    path.join(options.output, "index.html"),
    renderReport(model),
    "utf8"
  );
  await writeSummarySidecars(options.output, buildSummary(model), {
    reportUrl: options.publicUrl,
    runUrl: options.runUrl,
    title: "Night Watch",
  });
  process.stdout.write(
    `night watch: ${model.verdict.verdict} — ${model.lanes.length} lanes, ${model.validationErrors.length} validation errors\n`
  );
  if (model.validationErrors.length > 0) {
    for (const error of model.validationErrors)
      process.stderr.write(`  ${error}\n`);
    process.exitCode = 1;
  }
}
