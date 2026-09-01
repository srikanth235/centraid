/**
 * Computed matrix grades (#656 Layer 2).
 *
 * The axiom: every quality claim is either computed by a machine or
 * adversarially verified — never asserted by the author. `tests/matrix.json`
 * still carries an `assessment` per cell, but that value is now a DECLARED
 * EXPECTATION that this module checks against evidence. An agent can only
 * declare two things by hand: who owns a cell, and which skips exist (with a
 * reason and a tracking issue). Everything else is derived here.
 *
 * The computation returns a CEILING — the best grade the evidence can support.
 * Declaring above the ceiling is an error; declaring below it is a warning.
 * The ceiling is derived from two evidence classes:
 *
 *   static  — always available, therefore always deterministic in `check:pr`:
 *             owner exists, owner declares >0 tests, owner cannot skip itself,
 *             the cell has a flow with a met `minimumTests`, the owning package
 *             is gated by a coverage floor (or, for perf/scale rigs, by a
 *             registered budget), and any mutation seed that applies is not
 *             below `_absoluteWeaknessBelow`.
 *   run     — optional: a fresh vitest report. It can only LOWER a ceiling
 *             (owner ran and failed, or ran zero tests). When it is absent or
 *             stale every run-derived fact is reported as "unknown" — never
 *             silently as evidence of health.
 *
 * Consequence, by construction: `solid` is uncomputable for a cell whose owner
 * can self-skip, whose flow has no `minimumTests`, or whose package sits below
 * the mutation weakness threshold.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { detectDefaultCiEnvGate } from "./report-signals.mjs";
import { scanSkipSites } from "./skip-inventory.mjs";

/** Grades ordered worst → best; index doubles as the comparison rank. */
export const GRADE_ORDER = ["gap", "partial", "solid"];

/** Evidence older than this is reported as unknown, matching the report stamp. */
export const MAX_EVIDENCE_AGE_HOURS = 36;

/** Tiers whose mechanical adversary is a registered wall-clock budget. */
const RIG_TIERS = new Set(["perf", "scale"]);
/** Tiers with no coverage/mutation signal — the lane run is the adversary. */
const LANE_TIERS = new Set(["e2e"]);

export function gradeRank(grade) {
  const rank = GRADE_ORDER.indexOf(grade);
  return rank < 0 ? 0 : rank;
}

const lower = (grade, cap) => (gradeRank(cap) < gradeRank(grade) ? cap : grade);

/**
 * Count the checks a file declares. Static, so it works before any lane runs —
 * which is the only way "zero-test owner" can red a PR rather than a nightly.
 *
 * Vitest/Playwright owners declare `test(` / `it(`. The agent-e2e harnesses are
 * not vitest at all: one `runFlow()` per file, with imperative `throw new
 * Error(...)`, `ctx.expect*()`, and embedded Maestro assertions doing the
 * asserting. Counting `test(` there would report zero and grade every real
 * pairing/mobile flow a gap, so those owners are counted in their own grammar.
 *
 * A SHARED CONSTANT THAT EMITS AN ASSERTION COUNTS AS ONE (#905). This is a
 * text scanner, so an assertion factored out of a flow and into the harness
 * becomes invisible to it — and it under-counts SILENTLY, which is the failure
 * mode to fear: the flow still asserts exactly as much, but the matrix reads a
 * shrunken contract and the obvious way to make it green again is to lower a
 * `minimumTests`. So the harness constants that expand to an assertion are
 * named here, and only those: `retryableTapCommands`, `CONFIRM_SYSTEM_OPEN` and
 * `DENY_MEDIA_PERMISSION` expand to taps and are deliberately absent, because a
 * tap proves nothing. Adding a name here is a claim that using it asserts.
 *
 * Matched as the INTERPOLATION, `${NAME}`, not as the bare identifier: the
 * import at the top of the file names it too, and an import asserts nothing.
 */
const FLOW_ASSERTION_HELPERS = /\$\{AWAIT_LAUNCHER\}/u;

export function countDeclaredTests(source, file = "") {
  if (typeof source !== "string") return 0;
  if (/^tests\/agent-e2e-[^/]+\/flows\/.+\.mjs$/u.test(file)) {
    const checks =
      source.match(
        new RegExp(
          `throw new Error\\(|\\bctx\\.expect\\w*\\s*\\(|\\bassert(?:Visible|NotVisible|True)\\s*:|\\bextendedWaitUntil\\s*:|${FLOW_ASSERTION_HELPERS.source}`,
          "gu"
        )
      )?.length ?? 0;
    return checks;
  }
  return source.match(/\b(?:test|it)(?:\.\w+)*\s*\(/gu)?.length ?? 0;
}

/**
 * Resolve the coverage-floor scope that gates the code an owner is testing.
 * Owners are test files, so the proxy is: does the owner's workspace declare a
 * floor at all? A package with no floor has no mechanical coverage adversary,
 * so it cannot back a computed `solid`.
 */
export function matchCoverageScope(ownerPath, floors, workspaces = []) {
  if (!ownerPath) return null;
  const owner = ownerPath.replaceAll("\\", "/");
  const workspace = [...workspaces]
    .filter((candidate) => owner.startsWith(`${candidate}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!workspace) return null;
  const scopes = Object.keys(floors ?? {}).filter(
    (key) =>
      !key.startsWith("_") && key !== "lines" && key !== "approvedDeviation"
  );
  const matched = scopes
    .filter((scope) => scope.startsWith(`${workspace}/`))
    .sort((a, b) => b.length - a.length);
  return matched[0] ?? null;
}

/** Resolve the mutation seed (if any) that covers an owner's workspace. */
export function matchMutationScope(ownerPath, mutationFloors) {
  if (!ownerPath) return null;
  const owner = ownerPath.replaceAll("\\", "/");
  const scopes = Object.keys(mutationFloors ?? {}).filter(
    (key) => !key.startsWith("_")
  );
  return (
    scopes
      .filter((scope) => owner.startsWith(`${scope}/`))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

/**
 * Compute one cell's grade ceiling from its evidence. Pure: every input is
 * supplied by the caller so the rules are unit-testable without a filesystem.
 */
export function computeCellGrade(cell) {
  const reasons = [];
  const evidence = {
    ownerExists: cell.ownerExists === true,
    declaredTests: cell.declaredTests ?? 0,
    selfSkips: cell.skipSites?.length ?? 0,
    envGate: cell.envGate ?? null,
    minimumTests: null,
    coverageScope: cell.coverageScope ?? null,
    mutationScope: cell.mutationScope ?? null,
    mutationFloor: cell.mutationFloor ?? null,
    budgetRegistered: cell.budgetRegistered ?? null,
    run: cell.run ?? { state: "unknown" },
  };

  if (!cell.owner) {
    return { grade: "gap", reasons: ["no owning test is declared"], evidence };
  }
  if (!evidence.ownerExists) {
    return {
      grade: "gap",
      reasons: [`owner does not exist: ${cell.owner}`],
      evidence,
    };
  }
  if (evidence.declaredTests === 0) {
    return {
      grade: "gap",
      reasons: [`owner ${cell.owner} declares zero tests`],
      evidence,
    };
  }

  let grade = "solid";

  // 1. A cell whose owner can skip itself proves nothing on a green run.
  if (evidence.selfSkips > 0) {
    grade = lower(grade, "partial");
    reasons.push(
      `owner ${cell.owner} can skip itself (${evidence.selfSkips} inventoried skip site(s))`
    );
  }
  if (evidence.envGate) {
    grade = lower(grade, "partial");
    reasons.push(
      `owner ${cell.owner} is env-gated off default CI (${evidence.envGate.env} / ${evidence.envGate.kind})`
    );
  }

  // 2. A contract with no floor is prose. At least one flow must pin a
  //    minimumTests, and no flow on the cell may leave it undeclared.
  const flows = cell.flows ?? [];
  const floored = flows.filter((flow) => Number.isInteger(flow.minimumTests));
  evidence.minimumTests = floored.reduce(
    (sum, flow) => sum + flow.minimumTests,
    0
  );
  if (!flows.length) {
    grade = lower(grade, "partial");
    reasons.push("no canonical flow claims this cell");
  } else if (!floored.length) {
    grade = lower(grade, "partial");
    reasons.push(
      `no flow on this cell declares minimumTests (${flows.map((flow) => flow.id).join(", ")})`
    );
  } else if (floored.some((flow) => flow.minimumTests < 1)) {
    grade = lower(grade, "partial");
    reasons.push("a flow declares minimumTests: 0, which floors nothing");
  } else if (
    floored.some((flow) => (flow.declaredTests ?? 0) < flow.minimumTests)
  ) {
    grade = "gap";
    reasons.push("a flow's owner declares fewer tests than its minimumTests");
  }

  // 3. The declared cell owner must actually be one of the cell's flow owners.
  //    Otherwise the prose, the owner and the laws can each name a different
  //    file and nothing points at the proof.
  if (flows.length && !flows.some((flow) => flow.owner === cell.owner)) {
    grade = lower(grade, "partial");
    reasons.push(
      `cell owner ${cell.owner} owns none of this cell's flows (${flows.map((flow) => flow.owner).join(", ")})`
    );
  }

  // 4. One file cannot carry unlimited laws. Every file backing this cell must
  //    declare at least as many tests as the floors it has been signed up for —
  //    otherwise a 4-test file can be the sole proof of fifteen cells.
  for (const load of cell.fileLoads ?? []) {
    if (load.claimed > load.declared) {
      grade = lower(grade, "partial");
      reasons.push(
        `${load.file} is oversubscribed: it owns flows whose floors total ${load.claimed} but declares only ${load.declared} tests`
      );
    }
  }

  // 5. Tier-appropriate mechanical adversary.
  if (RIG_TIERS.has(cell.tier)) {
    if (cell.budgetRegistered !== true) {
      grade = lower(grade, "partial");
      reasons.push(
        `rig ${cell.owner} has no registered budget in tests/quality-rig-budgets.json`
      );
    }
  } else if (!LANE_TIERS.has(cell.tier)) {
    if (!evidence.coverageScope) {
      grade = lower(grade, "partial");
      reasons.push(
        `no coverage floor scope gates the workspace that owns ${cell.owner}`
      );
    } else if (
      cell.coverageMeasured &&
      cell.coverageFloor &&
      Number.isFinite(cell.coverageMeasured.lines) &&
      cell.coverageMeasured.lines < cell.coverageFloor.lines
    ) {
      grade = lower(grade, "partial");
      reasons.push(
        `measured coverage ${cell.coverageMeasured.lines} is under floor ${cell.coverageFloor.lines} for ${evidence.coverageScope}`
      );
    }
  }

  // 6. Mutation is the adversary that catches tests which execute without
  //    asserting. A seeded package below the weakness threshold cannot back a
  //    solid cell; an unseeded package simply has no mutation signal yet.
  if (
    evidence.mutationScope &&
    Number.isFinite(evidence.mutationFloor) &&
    Number.isFinite(cell.absoluteWeaknessBelow) &&
    evidence.mutationFloor < cell.absoluteWeaknessBelow
  ) {
    grade = lower(grade, "partial");
    reasons.push(
      `mutation floor ${evidence.mutationFloor} for ${evidence.mutationScope} is below _absoluteWeaknessBelow ${cell.absoluteWeaknessBelow}`
    );
  }
  if (
    evidence.mutationScope &&
    Number.isFinite(cell.mutationMeasured) &&
    Number.isFinite(evidence.mutationFloor) &&
    cell.mutationMeasured < evidence.mutationFloor
  ) {
    grade = lower(grade, "partial");
    reasons.push(
      `measured mutation score ${cell.mutationMeasured} is under floor ${evidence.mutationFloor}`
    );
  }

  // 7. Run evidence never raises a ceiling; absent or stale evidence is
  //    reported as unknown rather than treated as health.
  const run = evidence.run;
  if (run?.state === "zero") {
    grade = "gap";
    reasons.push(
      `owner ${cell.owner} executed zero tests in the latest fresh run`
    );
  } else if (run?.state === "failed") {
    grade = "gap";
    reasons.push(`owner ${cell.owner} failed in the latest fresh run`);
  }

  return { grade, reasons, evidence };
}

/** Load a JSON file, returning `fallback` when it is absent or unreadable. */
async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Read the latest vitest report when it is fresh enough to be evidence.
 * Returns a map of repo-relative owner path → { executed, failed }.
 */
export async function readRunEvidence({
  root,
  vitestPath = path.join(root, "artifacts/test-results/vitest.json"),
  nowMs = Date.now(),
  maxAgeHours = MAX_EVIDENCE_AGE_HOURS,
} = {}) {
  let stamp;
  try {
    stamp = await stat(vitestPath);
  } catch {
    return { state: "absent", owners: new Map() };
  }
  const report = await readJson(vitestPath);
  if (!report) return { state: "absent", owners: new Map() };
  const startedMs = Number(report.startTime ?? stamp.mtimeMs);
  if (!Number.isFinite(startedMs))
    return { state: "absent", owners: new Map() };
  if (nowMs - startedMs > maxAgeHours * 3_600_000) {
    return { state: "stale", owners: new Map() };
  }
  const owners = new Map();
  for (const file of report.testResults ?? []) {
    const name = String(file.name ?? "").replaceAll("\\", "/");
    const relative = name.startsWith(`${root.replaceAll("\\", "/")}/`)
      ? name.slice(root.length + 1)
      : name;
    const assertions = file.assertionResults ?? [];
    owners.set(relative, {
      executed: assertions.filter((entry) => entry.status !== "pending").length,
      failed: assertions.filter((entry) => entry.status === "failed").length,
      total: assertions.length,
    });
  }
  return { state: "fresh", owners };
}

function runStateFor(owner, runEvidence) {
  if (!runEvidence || runEvidence.state !== "fresh") {
    return { state: "unknown", why: runEvidence?.state ?? "absent" };
  }
  const result = runEvidence.owners.get(owner);
  // A file the lane never selected (test:affected) is unknown, not zero.
  if (!result) return { state: "unknown", why: "not in the latest run" };
  if (result.failed > 0) return { state: "failed", ...result };
  if (result.executed === 0) return { state: "zero", ...result };
  return { state: "passed", ...result };
}

/**
 * Grade every owned cell in the matrix against the evidence on disk.
 * Returns { cells, errors, warnings } — errors are merge blockers.
 */
export async function gradeMatrix(matrix, options = {}) {
  const root = options.root ?? process.cwd();
  const sources = options.sources ?? new Map();
  // Every file the grading needs, read once and in parallel, so the rules
  // below stay synchronous and the whole pass costs one round of I/O.
  const wanted = new Set(
    [
      ...Object.values(matrix.cellOwners ?? {}).map((cell) => cell?.owner),
      ...(matrix.flows ?? []).map((flow) => flow.owner),
    ].filter((file) => typeof file === "string" && !sources.has(file))
  );
  await Promise.all(
    [...wanted].map(async (relative) => {
      try {
        sources.set(
          relative,
          await readFile(path.join(root, relative), "utf8")
        );
      } catch {
        sources.set(relative, null);
      }
    })
  );
  const readSource = (relative) => sources.get(relative) ?? null;

  const coverageFloors =
    options.coverageFloors ??
    (await readJson(path.join(root, "tests/coverage-floors.json"), {}));
  const mutationFloors =
    options.mutationFloors ??
    (await readJson(path.join(root, "tests/mutation-floors.json"), {}));
  const rigBudgets =
    options.rigBudgets ??
    (await readJson(path.join(root, "tests/quality-rig-budgets.json"), {
      rigs: {},
    }));
  const runEvidence =
    options.runEvidence ??
    (options.checkRunEvidence === false
      ? { state: "absent", owners: new Map() }
      : await readRunEvidence({ root, nowMs: options.nowMs }));
  const workspaces = Object.keys(matrix.workspaceSurfaces ?? {});
  const weaknessBelow = mutationFloors._absoluteWeaknessBelow;

  const flowsByCell = new Map();
  for (const flow of matrix.flows ?? []) {
    const cellId = `${flow.surface}.${flow.dimension}`;
    if (!flowsByCell.has(cellId)) flowsByCell.set(cellId, []);
    flowsByCell.get(cellId).push(flow);
  }

  const cells = [];
  const errors = [];
  const warnings = [];
  const inputs = [];
  const notes = matrix.notes ?? {};

  for (const surface of matrix.surfaces ?? []) {
    for (const dimension of matrix.dimensions ?? []) {
      const cellId = `${surface.id}.${dimension.id}`;
      const declared = surface.assessment?.[dimension.id];
      const cellOwner = matrix.cellOwners?.[cellId];
      const flows = flowsByCell.get(cellId) ?? [];

      // `skip` and `gap` are declarations the existing validator already
      // polices (rationale note / open tracking issue). They claim no proof,
      // so there is nothing to compute — but an owned flow must not hide there.
      if (declared === "skip" || declared === "gap") {
        for (const flow of flows) {
          const source = readSource(flow.owner);
          if (source !== null && countDeclaredTests(source, flow.owner) > 0) {
            warnings.push(
              `${cellId} is ${declared} but flow ${flow.id} owns real tests; grade it`
            );
          }
        }
        continue;
      }

      const owner = cellOwner?.owner ?? null;
      const source = owner ? readSource(owner) : null;
      const declaredTests =
        source === null ? 0 : countDeclaredTests(source, owner);
      const skipSites = source === null ? [] : scanSkipSites(owner, source);
      const envGate =
        source === null || owner?.endsWith(".mjs")
          ? null
          : detectDefaultCiEnvGate(source);
      const coverageScope = matchCoverageScope(
        owner,
        coverageFloors,
        workspaces
      );
      const mutationScope = matchMutationScope(owner, mutationFloors);

      const flowEvidence = [];
      for (const flow of flows) {
        const flowSource = readSource(flow.owner);
        flowEvidence.push({
          id: flow.id,
          owner: flow.owner,
          minimumTests: flow.minimumTests ?? null,
          declaredTests:
            flowSource === null
              ? 0
              : countDeclaredTests(flowSource, flow.owner),
        });
      }

      inputs.push({
        cellId,
        declared,
        input: {
          cellId,
          owner,
          tier: cellOwner?.tier,
          ownerExists: source !== null,
          declaredTests,
          skipSites,
          envGate,
          flows: flowEvidence,
          coverageScope,
          coverageFloor: coverageScope ? coverageFloors[coverageScope] : null,
          coverageMeasured: options.coverageMeasured?.[coverageScope] ?? null,
          mutationScope,
          mutationFloor: mutationScope ? mutationFloors[mutationScope] : null,
          mutationMeasured: options.mutationMeasured?.[mutationScope] ?? null,
          absoluteWeaknessBelow: weaknessBelow,
          budgetRegistered: owner ? Boolean(rigBudgets.rigs?.[owner]) : false,
          run: runStateFor(owner, runEvidence),
        },
      });
    }
  }

  // Second pass: how many laws each file has been signed up for, across every
  // cell in the matrix. Each flow's minimumTests is a distinct law, so a file
  // that owns several flows must declare enough tests to carry all of them.
  const fileLoad = new Map();
  for (const flow of matrix.flows ?? []) {
    if (!Number.isInteger(flow.minimumTests)) continue;
    const source = readSource(flow.owner);
    const load = fileLoad.get(flow.owner) ?? {
      file: flow.owner,
      claimed: 0,
      declared: source === null ? 0 : countDeclaredTests(source, flow.owner),
    };
    load.claimed += flow.minimumTests;
    fileLoad.set(flow.owner, load);
  }

  for (const { cellId, declared, input } of inputs) {
    const backing = new Set(
      [input.owner, ...input.flows.map((flow) => flow.owner)].filter(Boolean)
    );
    const computed = computeCellGrade({
      ...input,
      fileLoads: [...backing]
        .map((file) => fileLoad.get(file))
        .filter((load) => load && load.claimed > load.declared),
    });
    cells.push({ cellId, declared, computed: computed.grade, ...computed });

    if (gradeRank(declared) > gradeRank(computed.grade)) {
      errors.push(
        `${cellId} declares ${declared} but the evidence only supports ${computed.grade}: ${computed.reasons.join("; ")}`
      );
    } else if (gradeRank(declared) < gradeRank(computed.grade)) {
      // A deliberate under-claim is legitimate — the evidence can be mechanically
      // sufficient while a human knows a platform or journey is still missing.
      // The note is where that judgement lives, so only an unexplained
      // under-claim is worth a warning.
      const note = notes[cellId];
      if (typeof note !== "string" || !note.trim()) {
        warnings.push(
          `${cellId} declares ${declared} but the evidence supports ${computed.grade}; promote it or write the note that explains the under-claim`
        );
      }
    }
  }

  return { cells, errors, warnings, runEvidence: runEvidence.state };
}
