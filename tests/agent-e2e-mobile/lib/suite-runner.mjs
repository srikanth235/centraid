import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const KILL_GRACE_MS = 5_000;
const DETACHED = process.platform !== "win32";
const IDENTITY_FIELDS = [
  "platform",
  "udid",
  "appId",
  "gatewayUrl",
  "fixtureId",
];

function suiteSlug(suite) {
  return suite
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

async function readPrerequisite(file) {
  try {
    const marker = JSON.parse(await fs.readFile(file, "utf8"));
    const valid =
      marker?.ready === true &&
      ["runId", ...IDENTITY_FIELDS].every(
        (field) => typeof marker[field] === "string" && marker[field].length > 0
      );
    return valid ? marker : null;
  } catch {
    return null;
  }
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left?.[field] === right?.[field]);
}

// A non-zero exit means different things depending on how far the flow got: a
// missing prerequisite marker says the fixture or pairing never came up, while
// a present one says the app assertion itself is what failed.
function classifyOutcome({ childRunnerError, timedOut, code, prerequisite }) {
  if (childRunnerError || timedOut) {
    return { failureClass: "infrastructure", phase: "execution" };
  }
  if (code === 0) return {};
  return prerequisite
    ? { failureClass: "product_assertion", phase: "assertion" }
    : { failureClass: "prerequisite", phase: "fixture_or_pairing" };
}

async function writeSyntheticEvidence(repoRoot, platform, result) {
  const slug = path.basename(result.file, ".mjs");
  const owner = path.relative(repoRoot, result.file).split(path.sep).join("/");
  const directory = path.join(repoRoot, "artifacts", "e2e");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, `${slug}-${platform}.json`),
    `${JSON.stringify(
      {
        lane: "e2e",
        owner,
        name: slug,
        platform,
        status: "failed",
        phase: result.phase ?? "blocked",
        reason: result.reason ?? result.status,
        capturedAt: new Date().toISOString(),
        measurements: [
          { name: "wall clock", value: result.elapsedMs, unit: "ms" },
        ],
      },
      null,
      2
    )}\n`
  );
}

function clearTimers(timers) {
  for (const timer of timers) clearTimeout(timer);
  timers.length = 0;
}

function runChild(file, { env, timeoutMs }) {
  const timers = [];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      detached: DETACHED,
      env,
      stdio: "inherit",
    });
    let timedOut = false;
    let forceKillTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        if (DETACHED && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // The child may already have completed.
      }
      forceKillTimer = setTimeout(() => {
        try {
          if (DETACHED && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // The process group exited during the grace period.
        }
      }, KILL_GRACE_MS);
      forceKillTimer.unref();
      timers.push(forceKillTimer);
    }, timeoutMs);
    timeout.unref();
    timers.push(timeout);
    // A child can emit both `error` and `close`; the first one that arrives
    // owns the verdict, and the second must not re-settle the promise.
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimers(timers);
      resolve({ code: code ?? 1, timedOut });
    };
    child.once("close", finish);
    child.once("error", () => finish(1));
  });
}

async function appendSummary(suite, budgetMs, elapsedMs, results, environment) {
  const lines = [
    `## ${suite} Maestro journeys`,
    "",
    `Suite wall clock: ${Math.ceil(elapsedMs / 1000)}s / ${Math.ceil(budgetMs / 1000)}s`,
    "",
    "| Journey | Result | Duration |",
    "| --- | --- | ---: |",
    ...results.map(
      (result) =>
        `| ${result.name} | ${result.status}${result.reason ? ` — ${result.reason}` : ""} | ${Math.ceil(result.elapsedMs / 1000)}s |`
    ),
    "",
  ];
  console.log(lines.join("\n"));
  if (environment.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(
      environment.GITHUB_STEP_SUMMARY,
      `${lines.join("\n")}\n`
    );
  }
}

export async function runMobileSuite({
  suite,
  budgetMs,
  flows,
  environment = process.env,
  repoRoot = REPO_ROOT,
  runnerTemp = environment.RUNNER_TEMP ??
    path.join(repoRoot, "artifacts", "tmp"),
  childRunner = runChild,
  failProcess = true,
}) {
  const platform = environment.MAESTRO_PLATFORM ?? "unspecified";
  const startedAt = performance.now();
  const deadline = startedAt + budgetMs;
  const markerDir = path.join(
    runnerTemp,
    "centraid-mobile-prerequisites",
    `${platform}-${suiteSlug(suite)}`
  );
  await fs.mkdir(markerDir, { recursive: true });

  const results = [];
  let prerequisiteBlocked = false;
  let pairedIdentity = null;
  for (const [index, flow] of flows.entries()) {
    if (prerequisiteBlocked) {
      results.push({
        name: flow.name,
        file: flow.file,
        status: "blocked",
        reason: "paired fixture was not established",
        elapsedMs: 0,
      });
      continue;
    }

    if (flow.reusePairedState && pairedIdentity === null) {
      results.push({
        name: flow.name,
        file: flow.file,
        status: "blocked",
        reason: "no verified paired fixture is available",
        elapsedMs: 0,
      });
      prerequisiteBlocked = true;
      continue;
    }

    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      results.push({
        name: flow.name,
        file: flow.file,
        status: "blocked",
        reason: "suite deadline expired",
        elapsedMs: 0,
      });
      prerequisiteBlocked = true;
      continue;
    }

    const prerequisiteFile = path.join(
      markerDir,
      `${String(index + 1).padStart(2, "0")}-${path.basename(flow.file, ".mjs")}.json`
    );
    // oxlint-disable-next-line no-await-in-loop -- one marker cleared per flow, immediately before that flow writes it
    await fs.rm(prerequisiteFile, { force: true });
    const flowStartedAt = performance.now();
    let child;
    let childRunnerError;
    try {
      // oxlint-disable-next-line no-await-in-loop -- the suite IS sequential: one simulator, and each flow inherits the paired state the previous one left
      child = await childRunner(flow.file, {
        timeoutMs: remainingMs,
        env: {
          ...environment,
          MOBILE_E2E_PREREQUISITE_FILE: prerequisiteFile,
          ...(flow.reusePairedState
            ? { MAESTRO_REUSE_PAIRED_STATE: "1" }
            : { MAESTRO_REUSE_PAIRED_STATE: "0" }),
        },
      });
    } catch (error) {
      childRunnerError = error;
      child = { code: 1, timedOut: false };
    }
    const elapsedMs = performance.now() - flowStartedAt;
    // oxlint-disable-next-line no-await-in-loop -- reads the marker the flow that just finished wrote; there is nothing to overlap it with
    const prerequisite = await readPrerequisite(prerequisiteFile);
    const identityMatches =
      prerequisite !== null &&
      (!flow.reusePairedState || sameIdentity(prerequisite, pairedIdentity));
    let status = child.timedOut
      ? "timed_out"
      : child.code === 0
        ? "success"
        : "failure";
    let reason = childRunnerError
      ? `child runner failed: ${childRunnerError.message ?? childRunnerError}`
      : undefined;
    let { failureClass, phase } = classifyOutcome({
      childRunnerError,
      timedOut: child.timedOut,
      code: child.code,
      prerequisite,
    });
    if (status === "success" && !identityMatches) {
      status = "failure";
      reason = prerequisite
        ? "paired fixture identity changed"
        : "paired fixture was not verified";
      failureClass = "prerequisite";
      phase = "fixture_identity";
    }
    results.push({
      name: flow.name,
      file: flow.file,
      status,
      ...(reason ? { reason } : {}),
      ...(failureClass ? { failureClass } : {}),
      ...(phase ? { phase } : {}),
      elapsedMs,
      pairedFixtureReady: identityMatches,
    });
    if (status !== "success") {
      console.error(
        `::error title=${suite}: ${flow.name}::${status} after ${Math.ceil(elapsedMs / 1000)}s`
      );
    }
    // Pairing/fixture readiness is orthogonal to the app assertion. Preserve a
    // trustworthy identity after an app-local failure so unrelated apps can
    // still produce independent signal; only a fixture-owning failure blocks.
    if (identityMatches && pairedIdentity === null) {
      pairedIdentity = prerequisite;
    }
    if (
      !identityMatches ||
      child.timedOut ||
      (flow.requiredForFollowing && status !== "success")
    ) {
      prerequisiteBlocked = true;
    }
  }

  const elapsedMs = performance.now() - startedAt;
  const withinBudget = elapsedMs <= budgetMs;
  await Promise.all(
    results
      .filter((result) => ["blocked", "timed_out"].includes(result.status))
      .map((result) => writeSyntheticEvidence(repoRoot, platform, result))
  );
  const outputDir = path.join(repoRoot, "artifacts", "e2e-suites");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, `${platform}-${suiteSlug(suite)}.json`),
    `${JSON.stringify(
      {
        suite,
        platform,
        budgetMs,
        elapsedMs,
        withinBudget,
        capturedAt: new Date().toISOString(),
        results,
      },
      null,
      2
    )}\n`
  );
  await appendSummary(suite, budgetMs, elapsedMs, results, environment);

  if (!withinBudget) {
    console.error(
      `::error title=${suite} budget::${Math.ceil(elapsedMs / 1000)}s exceeded ${Math.ceil(budgetMs / 1000)}s`
    );
  }
  if (
    failProcess &&
    (!withinBudget || results.some((result) => result.status !== "success"))
  ) {
    process.exitCode = 1;
  }
  return { elapsedMs, results, withinBudget };
}
