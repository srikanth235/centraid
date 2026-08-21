/**
 * Structural gate for the nightly product lane (#464): pairing journeys live
 * inside `.github/workflows/e2e.yml` and no longer depend on a standalone
 * pairing-relay workflow or a cross-run `gh run download`.
 *
 * This is the real shipped wiring (the YAML GHA executes), not a reimplementation
 * of the flows themselves.
 */
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const e2ePath = path.join(root, ".github/workflows/e2e.yml");
const removedPath = path.join(root, ".github/workflows/pairing-relay-e2e.yml");
const enrichmentLivePath = path.join(
  root,
  ".github/workflows/enrichment-live-weekly.yml"
);
const soakWeeklyPath = path.join(root, ".github/workflows/soak-weekly.yml");

const requiredFlowScripts = [
  "tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs",
  "tests/agent-e2e-pairing/flows/pairing-ticket-hygiene.mjs",
  "tests/agent-e2e-pairing/flows/cross-network-relay.mjs",
  // #839 G8 — a committed Maestro suite that e2e.yml never invokes is a roster
  // that silently stopped running; the mobile jobs must call both suites.
  "tests/agent-e2e-mobile/run-photos-suite.mjs",
  "tests/agent-e2e-mobile/run-home-apps-suite.mjs",
];

const requiredJobs = [
  "pairing-lifecycle:",
  "pairing-ticket-hygiene:",
  "pairing-cross-network-relay:",
  // #532 — mutation scores must reach the report job via nightly-evidence-*.
  "mutation-testing:",
  // #839 G10 — the fuzz lane is nightly-only and owns its own job; its summary
  // reaches the report through the same nightly-evidence-* channel.
  "fuzz-parsers:",
  // #842 W2.4 — the DAST lane boots a real gateway and scans it, so it is
  // nightly-only and owns its own job; its summary reaches the report through
  // the same nightly-evidence-* channel.
  "dast-scan:",
  // #839 G11/G12 — the protocol join lane (one gateway, N mounted vaults, one
  // iroh client per seat) runs at width here; the PR path runs the same file at
  // its 3-seat floor.
  "protocol-join:",
];

const requiredArtifactNames = [
  "nightly-evidence-pairing-lifecycle",
  "nightly-evidence-pairing-ticket-hygiene",
  "nightly-evidence-pairing-cross-network-relay",
  "nightly-evidence-mutation",
  "nightly-evidence-fuzz",
  "nightly-evidence-dast",
  "nightly-evidence-join",
];

const errors = [];

const e2e = await readFile(e2ePath, "utf8");
// Strip YAML comments so prose about retired cross-workflow fetch does not
// trip the shell-command ban.
const e2eCode = e2e
  .split("\n")
  .map((line) => {
    const hash = line.indexOf("#");
    return hash === -1 ? line : line.slice(0, hash);
  })
  .join("\n");

for (const job of requiredJobs) {
  if (!e2eCode.includes(job)) errors.push(`e2e.yml missing job key ${job}`);
}

for (const script of requiredFlowScripts) {
  if (!e2eCode.includes(script))
    errors.push(`e2e.yml does not invoke ${script}`);
}

for (const name of requiredArtifactNames) {
  // Boundary-anchored, not includes(): a superstring rename (say,
  // nightly-evidence-joinery) must fail, or the report job's merge-multiple
  // download silently loses the evidence while this gate stays green.
  if (!new RegExp(`${name}(?![\\w-])`, "u").test(e2eCode))
    errors.push(`e2e.yml missing artifact name ${name}`);
}

if (!e2eCode.includes("pattern: nightly-evidence-*")) {
  errors.push("e2e.yml report job must download nightly-evidence-* artifacts");
}

const reportIdx = e2eCode.indexOf("test-health-report:");
if (reportIdx === -1) {
  errors.push("e2e.yml missing test-health-report job");
} else {
  const reportChunk = e2eCode.slice(reportIdx, reportIdx + 1_200);
  for (const need of [
    "mobile-e2e-android",
    "pairing-lifecycle",
    "pairing-ticket-hygiene",
    "pairing-cross-network-relay",
    "mutation-testing",
    "fuzz-parsers",
    "dast-scan",
    "protocol-join",
  ]) {
    if (!reportChunk.includes(need)) {
      errors.push(`test-health-report needs must include ${need}`);
    }
  }
}

// #532 — mutation upload must be `path: artifacts/` (not `artifacts/mutation/`).
// download-artifact merge-multiple into `artifacts` flattens the uploaded root:
// uploading the mutation subdir alone lands scores.json at artifacts/scores.json
// while generate.mjs reads artifacts/mutation/scores.json.
const mutationJobIdx = e2eCode.indexOf("mutation-testing:");
if (mutationJobIdx === -1) {
  errors.push("e2e.yml missing mutation-testing job");
} else {
  const mutationChunk = e2eCode.slice(mutationJobIdx, mutationJobIdx + 1_800);
  if (!mutationChunk.includes("nightly-evidence-mutation")) {
    errors.push(
      "mutation-testing job must upload artifact nightly-evidence-mutation"
    );
  }
  // Prefer path: artifacts/ over path: artifacts/mutation/ so the mutation/
  // prefix survives download into the report job.
  if (/path:\s*artifacts\/mutation\/?/u.test(mutationChunk)) {
    errors.push(
      "mutation-testing must upload path: artifacts/ (not artifacts/mutation/) so scores stay at artifacts/mutation/scores.json after merge-multiple download"
    );
  } else if (
    !/path:\s*artifacts\/?\s*$/mu.test(mutationChunk) &&
    !/path:\s*artifacts\/\s*$/mu.test(mutationChunk)
  ) {
    // Accept `path: artifacts/` or `path: artifacts`
    if (
      !/name:\s*nightly-evidence-mutation[\s\S]{0,200}?path:\s*artifacts\/?/u.test(
        mutationChunk
      )
    ) {
      errors.push(
        "mutation-testing must upload path: artifacts/ next to nightly-evidence-mutation (preserves mutation/ prefix for generate.mjs)"
      );
    }
  }
}

// #839 G10 — the fuzz lane is only worth having if its evidence and its
// regression memory both survive. The summary must land at
// artifacts/fuzz/summary.json after the report job's merge-multiple download
// (same `path: artifacts/` rule as the mutation lane), and the job must replay
// the committed crasher corpus even when the search itself went red — a
// crasher that stops reproducing is news, not a reason to skip the check.
const fuzzJobIdx = e2eCode.indexOf("fuzz-parsers:");
if (fuzzJobIdx === -1) {
  errors.push("e2e.yml missing fuzz-parsers job");
} else {
  const fuzzChunk = e2eCode.slice(fuzzJobIdx, fuzzJobIdx + 1_800);
  if (!fuzzChunk.includes("bun run test:fuzz\n")) {
    errors.push(
      "fuzz-parsers job must run the full lane via bun run test:fuzz"
    );
  }
  if (!fuzzChunk.includes("bun run test:fuzz:replay")) {
    errors.push(
      "fuzz-parsers job must replay the committed crasher corpus via bun run test:fuzz:replay"
    );
  }
  if (/path:\s*artifacts\/fuzz\/?/u.test(fuzzChunk)) {
    errors.push(
      "fuzz-parsers must upload path: artifacts/ (not artifacts/fuzz/) so the summary stays at artifacts/fuzz/summary.json after merge-multiple download"
    );
  }
  if (
    !/name:\s*nightly-evidence-fuzz[\s\S]{0,200}?path:\s*artifacts\/?/u.test(
      fuzzChunk
    )
  ) {
    errors.push(
      "fuzz-parsers must upload path: artifacts/ next to nightly-evidence-fuzz (preserves fuzz/ prefix for the report lane)"
    );
  }
}

// #842 W2.4 — same `path: artifacts/` rule as the fuzz and mutation lanes: the
// scanner writes artifacts/dast/summary.json, and uploading the subdir alone
// would flatten it to artifacts/summary.json after merge-multiple download.
const dastJobIdx = e2eCode.indexOf("dast-scan:");
if (dastJobIdx === -1) {
  errors.push("e2e.yml missing dast-scan job");
} else {
  const dastChunk = e2eCode.slice(dastJobIdx, dastJobIdx + 1_800);
  if (!dastChunk.includes("node scripts/security/dast-scan.mjs")) {
    errors.push(
      "dast-scan job must run the lane via node scripts/security/dast-scan.mjs"
    );
  }
  if (/path:\s*artifacts\/dast\/?/u.test(dastChunk)) {
    errors.push(
      "dast-scan must upload path: artifacts/ (not artifacts/dast/) so the summary stays at artifacts/dast/summary.json after merge-multiple download"
    );
  }
  if (
    !/name:\s*nightly-evidence-dast[\s\S]{0,200}?path:\s*artifacts\/?/u.test(
      dastChunk
    )
  ) {
    errors.push(
      "dast-scan must upload path: artifacts/ next to nightly-evidence-dast (preserves dast/ prefix for the report lane)"
    );
  }
}

// #839 G11/G12 — the protocol JOIN lane. What makes this lane worth a job is
// exactly what a well-meaning edit would drop first: it must run the join file
// at WIDTH (a seat count the PR path does not pay for), and its per-test
// durations must survive to the report as evidence. A job that ran the same
// three-seat floor the PR lane already runs would be a duplicate, and a job
// whose JSON report never reached artifacts/join/summary.json would be a lane
// nobody can read afterwards.
const joinJobIdx = e2eCode.indexOf("protocol-join:");
if (joinJobIdx === -1) {
  errors.push("e2e.yml missing protocol-join job");
} else {
  const joinChunk = e2eCode.slice(joinJobIdx, joinJobIdx + 1_800);
  if (!joinChunk.includes("protocol-join-lane")) {
    errors.push(
      "protocol-join job must run packages/server/src/serve/protocol-join-lane.test.ts (filter: protocol-join-lane)"
    );
  }
  if (
    !/CENTRAID_JOIN_SEATS:\s*"[3-9]|CENTRAID_JOIN_SEATS:\s*"\d{2}/u.test(
      joinChunk
    )
  ) {
    errors.push(
      "protocol-join job must set CENTRAID_JOIN_SEATS to at least 3 — a nightly join lane that does not widen the seat count only repeats the PR run"
    );
  }
  if (!joinChunk.includes("--outputFile=artifacts/join/summary.json")) {
    errors.push(
      "protocol-join job must write its vitest JSON report to artifacts/join/summary.json (the lane's evidence)"
    );
  }
  if (/path:\s*artifacts\/join\/?/u.test(joinChunk)) {
    errors.push(
      "protocol-join must upload path: artifacts/ (not artifacts/join/) so the summary stays at artifacts/join/summary.json after merge-multiple download"
    );
  }
  if (
    !/name:\s*nightly-evidence-join[\s\S]{0,200}?path:\s*artifacts\/?/u.test(
      joinChunk
    )
  ) {
    errors.push(
      "protocol-join must upload path: artifacts/ next to nightly-evidence-join (preserves join/ prefix for the report lane)"
    );
  }
}

// Executable shell cross-workflow fetch — ban the retired pairing satellite.
const shellBans = [
  /gh\s+run\s+list[^\n]*pairing-relay-e2e/u,
  /gh\s+run\s+download/u,
  /pairing-relay-e2e\.yml/u,
];
for (const ban of shellBans) {
  if (ban.test(e2eCode)) {
    errors.push(
      `e2e.yml must not retain cross-workflow pairing fetch (${ban})`
    );
  }
}

// #725 — real model weights are deliberately weekly/manual, but their latest
// artifact must be restored into the health report and failures must page via
// the same deduplicating issue helper as the existing weekly lanes.
const enrichmentLive = await readFile(enrichmentLivePath, "utf8").catch(
  () => ""
);
for (const required of [
  "schedule:",
  "workflow_dispatch:",
  "packages/model-runtime/models.lock.json",
  "bun run --cwd packages/model-runtime setup",
  "bun run test:enrich:live",
  "artifacts/enrichment-live/",
  "scripts/ci/file-tracking-issue.mjs",
  "[enrichment-live] real-model goldens red",
  "within 24 hours or before the next scheduled run",
  "eight-day freshness window",
]) {
  if (!enrichmentLive.includes(required))
    errors.push(`enrichment-live-weekly.yml missing ${required}`);
}
// #842 W3.4 — the four-hour soak. The nightly scale lane already runs this
// rig at its 0.75-minute default, so the ONLY thing that makes the weekly lane
// worth a 300-minute runner is the duration override: a weekly job that
// silently fell back to the nightly default would repeat the nightly and prove
// nothing. That is why the literal is checked, exactly as the join lane's
// CENTRAID_JOIN_SEATS floor is.
const soakWeekly = await readFile(soakWeeklyPath, "utf8").catch(() => "");
for (const required of [
  "schedule:",
  "workflow_dispatch:",
  "tests/scale/long-run-soak.scale.test.ts",
  'CENTRAID_SOAK_MINUTES: "240"',
  "scripts/ci/file-tracking-issue.mjs",
  "[soak] weekly four-hour soak red",
  "within 24 hours or before the next scheduled run",
]) {
  if (!soakWeekly.includes(required))
    errors.push(`soak-weekly.yml missing ${required}`);
}

for (const required of [
  "Restore latest weekly real-model evidence",
  [
    "restore-keys: enrichment-live-",
    String.fromCharCode(36),
    "{{ runner.os }}-",
  ].join(""),
]) {
  if (!e2eCode.includes(required))
    errors.push(`e2e.yml report job missing ${required}`);
}

try {
  await access(removedPath);
  errors.push(
    "standalone workflow still present: .github/workflows/pairing-relay-e2e.yml"
  );
} catch {
  // expected — file deleted
}

// --- Rig budget registry completeness (#656 Layer 1F) ----------------------
// `tests/quality-rig-budgets.json` documented 9 of the 24 committed rigs and
// nothing read it, so it drifted silently for two milestones. Making it
// exhaustive is only durable if something fails when it stops being
// exhaustive — that is this block. A new rig must declare its lane and volume;
// a deleted rig must not leave a phantom entry behind.
const LANES = [
  { lane: "perf", suffix: ".perf.test.ts" },
  { lane: "scale", suffix: ".scale.test.ts" },
];

const budgets = JSON.parse(
  await readFile(path.join(root, "tests/quality-rig-budgets.json"), "utf8")
);
const registered = new Set(Object.keys(budgets.rigs ?? {}));

// Read every lane directory and every rig source up front: the checks below are
// pure over that snapshot, so no I/O sits inside a loop.
const laneListings = await Promise.all(
  LANES.map(async ({ lane, suffix }) => ({
    lane,
    names: (await readdir(path.join(root, "tests", lane))).filter((name) =>
      name.endsWith(suffix)
    ),
  }))
);
const rigs = await Promise.all(
  laneListings.flatMap(({ lane, names }) =>
    names.map(async (name) => ({
      lane,
      key: `tests/${lane}/${name}`,
      source: await readFile(path.join(root, "tests", lane, name), "utf8"),
    }))
  )
);
const orphanChecks = await Promise.all(
  [...registered].map(async (rig) => {
    const present = await access(path.join(root, rig)).then(
      () => true,
      () => false
    );
    return { rig, present };
  })
);

for (const { lane, key, source } of rigs) {
  const entry = budgets.rigs?.[key];
  if (entry) {
    registered.delete(key);
    if (entry.lane !== lane)
      errors.push(
        `tests/quality-rig-budgets.json entry ${key} declares lane "${entry.lane}" but lives in tests/${lane}`
      );
    if (typeof entry.volume !== "string" || entry.volume.trim() === "")
      errors.push(
        `tests/quality-rig-budgets.json entry ${key} needs a non-empty volume descriptor`
      );
    if ("budgetMs" in entry && !(entry.budgetMs > 0))
      errors.push(
        `tests/quality-rig-budgets.json entry ${key} has a non-positive budgetMs`
      );
  } else {
    errors.push(
      `tests/quality-rig-budgets.json has no entry for rig ${key} (declare its lane and volume)`
    );
  }
  // A rig that inlines its own absolute ceiling is invisible to test:ratchet.
  if (/^const BUDGET_MS\s*=\s*[\d_]+/mu.test(source))
    errors.push(
      `${key} inlines a numeric BUDGET_MS — declare budgetMs in tests/quality-rig-budgets.json and read it with rigBudgetMs(OWNER) so the ratchet sees it`
    );
  // #659 R4 — every rig must consume its own history. An absolute ceiling set
  // at ~3x a baseline only fires on a collapse: before this rule, a rig could
  // walk from 40 ms to 110 ms under a 120 ms ceiling across a year of green
  // nightlies and no gate anywhere would say a word. `rigDriftBudgetMs` (30
  // samples, 1.5x trailing median) is the drift gate; `qualityRegressionBudget`
  // is the older 10-sample/3x catastrophe gate and still counts as consuming
  // history. A rig that reads neither is fenced only against catastrophe.
  if (
    !source.includes("rigDriftBudgetMs") &&
    !source.includes("qualityRegressionBudget")
  )
    errors.push(
      `${key} never reads its own sample history — call rigDriftBudgetMs("${lane}", OWNER) from tests/helpers/rig-budgets.js and fold the result into the recorded status and an assertion`
    );
}

// Non-vitest rigs (the mobile on-device flow) may stay registered as long as
// the file they name still exists.
for (const { rig, present } of orphanChecks) {
  if (!present && registered.has(rig))
    errors.push(
      `tests/quality-rig-budgets.json registers ${rig}, which no longer exists`
    );
}

if (errors.length) {
  for (const error of errors) console.error(`nightly-wiring: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    "nightly-wiring: e2e.yml owns pairing lifecycle, ticket-hygiene, cross-network-relay, mutation-testing, fuzz-parsers, dast-scan, and protocol-join; weekly enrichment-live and soak lanes wired; standalone pairing-relay-e2e removed"
  );
}
