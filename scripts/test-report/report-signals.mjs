/**
 * Pure helpers for the test-health report inventory signals (#464 backlog).
 * Kept free of I/O so unit tests drive the real logic without regenerating HTML.
 */

/**
 * Extract unhandled/uncaught Vitest errors from a Jest-compatible vitest JSON
 * report. Also detects success=false with zero failed assertions (the EPIPE
 * class of "all tests green, process still fails").
 */
export function extractUnhandledErrors(vitest) {
  if (!vitest || typeof vitest !== "object") return [];
  const messages = [];

  if (Array.isArray(vitest.unhandledErrors)) {
    for (const entry of vitest.unhandledErrors) {
      if (typeof entry === "string") messages.push(entry);
      else if (entry && typeof entry === "object") {
        messages.push(String(entry.message ?? entry.name ?? entry));
      }
    }
  }

  let failedAssertions = 0;
  for (const file of vitest.testResults ?? vitest.files ?? []) {
    for (const assertion of file.assertionResults ?? file.tests ?? []) {
      if (assertion.status === "failed") failedAssertions += 1;
    }
    // Suite-level failure with no assertions often means load/runtime error.
    if (
      file.status === "failed" &&
      !(file.assertionResults ?? file.tests ?? []).some(
        (t) => t.status === "failed"
      )
    ) {
      const msg =
        file.message ||
        file.name ||
        file.filepath ||
        "suite failed without assertions";
      messages.push(String(msg));
    }
  }

  if (vitest.success === false && failedAssertions === 0) {
    const hasExplicit = messages.length > 0;
    if (!hasExplicit) {
      messages.push(
        "vitest reported success=false with zero failed tests (likely unhandled exception)"
      );
    }
  }

  return [...new Set(messages)];
}

/**
 * Summarize matrix cell states so "lane ran and failed" is distinct from
 * "no evidence / not run" in the report model.
 */
export function summarizeCellStates(cells) {
  const counts = {
    cellsPassed: 0,
    cellsFailed: 0,
    cellsMissing: 0,
    cellsSkipped: 0,
    cellsStale: 0,
    cellsFlaky: 0,
    cellsOwnerSilent: 0,
    cellsLaneDidNotRun: 0,
    cellsInfraMismatch: 0,
    cellsEvidenceUnmatched: 0,
  };
  for (const cell of cells ?? []) {
    if (cell.state === "passed") counts.cellsPassed += 1;
    else if (cell.state === "failed") counts.cellsFailed += 1;
    else if (
      [
        "missing",
        "evidence-unmatched",
        "owner-silent",
        "lane-did-not-run",
      ].includes(cell.state)
    )
      counts.cellsMissing += 1;
    else if (cell.state === "skipped") counts.cellsSkipped += 1;
    else if (cell.state === "stale") counts.cellsStale += 1;
    if (cell.state === "flaky") counts.cellsFlaky += 1;
    if (cell.state === "owner-silent") counts.cellsOwnerSilent += 1;
    if (cell.state === "lane-did-not-run") counts.cellsLaneDidNotRun += 1;
    if (cell.state === "infra-mismatch") counts.cellsInfraMismatch += 1;
    if (cell.state === "evidence-unmatched") counts.cellsEvidenceUnmatched += 1;
  }
  return counts;
}

/**
 * Resolve a Playwright JSON reporter `suite.file` to the repository-relative
 * owner key used by the matrix. Playwright emits paths relative to
 * `config.rootDir` (normally the project's testDir), including bare basenames.
 */
export function resolvePlaywrightOwner(
  value,
  { repoRoot = "", configRoot = "", registeredOwners = [] } = {}
) {
  const slash = (input) => String(input ?? "").replaceAll("\\", "/");
  const file = slash(value);
  const repository = slash(repoRoot).replace(/\/$/u, "");
  const root = slash(configRoot).replace(/\/$/u, "");
  if (!file) return "";

  const stripRepository = (candidate) =>
    repository && candidate.startsWith(`${repository}/`)
      ? candidate.slice(repository.length + 1)
      : candidate;
  if (file.startsWith("/") || /^[A-Za-z]:\//u.test(file)) {
    return stripRepository(file);
  }
  if (root) {
    const rooted = stripRepository(`${root}/${file}`.replace(/\/+/gu, "/"));
    if (!rooted.startsWith("../")) return rooted;
  }

  const owners = [...registeredOwners].map(slash);
  const suffixMatches = owners.filter(
    (owner) => owner === file || owner.endsWith(`/${file}`)
  );
  if (suffixMatches.length === 1) return suffixMatches[0];
  return stripRepository(file);
}

/** Flatten Playwright JSON while preserving the reporter's retry classification. */
export function collectPlaywrightEvidence(
  report,
  { lane = "playwright", resolveOwner = (value) => value } = {}
) {
  const evidence = [];
  const visit = (suites) => {
    for (const suite of suites ?? []) {
      if (suite.file) {
        const tests = (suite.specs ?? []).flatMap((spec) => spec.tests ?? []);
        const attempts = tests.flatMap((test) => test.results ?? []);
        const classifications = tests.map((test) =>
          String(test.status ?? "").toLowerCase()
        );
        let status = "missing";
        if (
          classifications.includes("unexpected") ||
          attempts.at(-1)?.status === "failed"
        ) {
          status = "failed";
        } else if (classifications.includes("flaky")) {
          status = "flaky";
        } else if (
          // Prefer passed when any test expected/passed: a single deliberate
          // test.skip must not classify the whole owner as skipped (#676 —
          // builder.spec mixed skip+pass was unmapped as "skipped").
          classifications.includes("expected") ||
          attempts.some((attempt) => attempt.status === "passed")
        ) {
          status = "passed";
        } else if (
          classifications.includes("skipped") ||
          (attempts.length &&
            attempts.every((attempt) => attempt.status === "skipped"))
        ) {
          status = "skipped";
        }
        const failedAttempt = attempts.find(
          (attempt) => attempt.status === "failed"
        );
        const error =
          failedAttempt?.error?.message ??
          failedAttempt?.errors?.[0]?.message ??
          tests
            .flatMap((test) => test.results ?? [])
            .flatMap((attempt) => attempt.errors ?? [])
            .find((entry) => entry?.message)?.message ??
          null;
        evidence.push({
          owner: resolveOwner(suite.file),
          status,
          lane,
          duration: attempts.reduce(
            (sum, attempt) => sum + Number(attempt.duration ?? 0),
            0
          ),
          error: error ? String(error) : null,
          retries: Math.max(
            0,
            ...attempts.map((attempt) => attempt.retry ?? 0)
          ),
          attachments: attempts.flatMap((attempt) => attempt.attachments ?? []),
        });
      }
      visit(suite.suites);
    }
  };
  visit(report?.suites);
  return evidence;
}

/**
 * Detect whole-file env gates that mean the owner never runs on default CI
 * (no special CENTRAID_* flags). Used by matrix validation and report inventory.
 */
export function detectDefaultCiEnvGate(source) {
  if (typeof source !== "string" || !source.trim()) return null;
  // describe.skipIf(process.env.FOO !== '1')
  const skipIfNeq = source.match(
    /describe\.skipIf\(\s*process\.env\.(?<env>[A-Z0-9_]+)\s*!==\s*['"]1['"]\s*\)/u
  );
  if (skipIfNeq)
    return { env: skipIfNeq.groups?.env, kind: "skipIf-env-not-1" };
  // describe.skipIf(!enabled) where enabled = process.env.X === '1' nearby
  const enabled =
    source.match(
      /const\s+\w+\s*=\s*process\.env\.(?<env>[A-Z0-9_]+)\s*===\s*['"]1['"]/u
    ) ||
    source.match(
      /const\s+\w+\s*=\s*process\.env\.(?<env>[A-Z0-9_]+)\s*===\s*['"]1['"]\s*\|\|/u
    );
  if (enabled && /describe\.skipIf\(\s*!?\w+\s*\)/u.test(source)) {
    return { env: enabled.groups?.env, kind: "skipIf-enabled-flag" };
  }
  // if (process.env.FOO !== '1') { t.skip / test.skip / describe.skip / return }
  // Covers disk-full.integration.test.ts style: env check then t.skip in the
  // test callback (whole owner is a no-op on default CI without the flag).
  const skipCall = "(?:test|it|t|describe)\\.skip";
  const early =
    source.match(
      new RegExp(
        String.raw`if\s*\(\s*process\.env\.(?<env>[A-Z0-9_]+)\s*!==\s*['"]1['"]\s*\)\s*\{[\s\S]{0,200}?${skipCall}`,
        "u"
      )
    ) ||
    source.match(
      new RegExp(
        String.raw`if\s*\(\s*process\.env\.(?<env>[A-Z0-9_]+)\s*!==\s*['"]1['"]\s*\)\s*${skipCall}`,
        "u"
      )
    ) ||
    source.match(
      /if\s*\(\s*process\.env\.(?<env>[A-Z0-9_]+)\s*!==\s*['"]1['"]\s*\)\s*\{[\s\S]{0,200}?\breturn\b/u
    );
  if (early) return { env: early.groups?.env, kind: "early-env-return" };
  // A skip/run conditional that mentions an environment variable but does not
  // match a supported whole-owner shape must be loud. Returning an explicit
  // unknown kind lets validation fail closed instead of preserving a false
  // solid cell.
  const inlineUnknown = source.match(
    /\.(?:skipIf|runIf)\(\s*[\s\S]{0,120}?process\.env\.(?<env>[A-Z0-9_]+)/u
  );
  const envAssignment = source.match(
    /(?:const|let)\s+(?<variable>\w+)\s*=\s*[\s\S]{0,80}?process\.env\.(?<env>[A-Z0-9_]+)/u
  );
  const assignedGate =
    envAssignment &&
    new RegExp(
      String.raw`\.(?:skipIf|runIf)\(\s*(?:Boolean\(\s*)?!?${envAssignment.groups?.variable}\s*\)?\s*\)`,
      "u"
    ).test(source);
  if (inlineUnknown || assignedGate) {
    return {
      env:
        inlineUnknown?.groups?.env ?? envAssignment?.groups?.env ?? "unknown",
      kind: "unparseable-env-gate",
    };
  }
  return null;
}

/** Inventory solid/partial cell owners that are whole-file env-gated off default CI. */
export async function collectEnvGatedOwners(manifest, { root, readFile }) {
  const rows = await Promise.all(
    Object.entries(manifest.cellOwners ?? {}).map(
      async ([cellId, cellOwner]) => {
        if (!cellOwner?.owner) return undefined;
        const [surfaceId, dimensionId] = cellId.split(".");
        const surface = (manifest.surfaces ?? []).find(
          (entry) => entry.id === surfaceId
        );
        const assessment = surface?.assessment?.[dimensionId];
        if (assessment !== "solid" && assessment !== "partial")
          return undefined;
        try {
          const source = await readFile(`${root}/${cellOwner.owner}`, "utf8");
          const gate = detectDefaultCiEnvGate(source);
          if (gate) {
            return {
              cellId,
              owner: cellOwner.owner,
              assessment,
              env: gate.env,
              kind: gate.kind,
            };
          }
        } catch {
          // missing file is a matrix validation error, not inventory
        }
        return undefined;
      }
    )
  );
  return rows.filter((row) => row !== undefined);
}

/**
 * Collect every owner path registered on the matrix (cellOwners + flows).
 * Used to detect orphaned e2e evidence that would otherwise drop on the floor (#535 F3).
 */
export function collectRegisteredOwners(manifest) {
  const owners = new Set();
  for (const cellOwner of Object.values(manifest?.cellOwners ?? {})) {
    if (cellOwner?.owner)
      owners.add(String(cellOwner.owner).replaceAll("\\", "/"));
  }
  for (const flow of manifest?.flows ?? []) {
    if (flow?.owner) owners.add(String(flow.owner).replaceAll("\\", "/"));
  }
  return owners;
}

/**
 * Evidence JSON whose owner is not registered on any matrix cell/flow.
 * @returns {{ unmapped: object[], failedUnmapped: object[], unmappedEvidence: number }} Unmapped rows and counts.
 */
export function findUnmappedEvidence(
  results,
  manifest,
  { normalizeOwner } = {}
) {
  const registered = collectRegisteredOwners(manifest);
  const norm =
    typeof normalizeOwner === "function"
      ? normalizeOwner
      : (value) => String(value ?? "").replaceAll("\\", "/");
  const unmapped = [];
  for (const result of results ?? []) {
    const owner = norm(result?.owner);
    if (!owner) continue;
    if (!registered.has(owner)) unmapped.push({ ...result, owner });
  }
  const failedUnmapped = unmapped.filter((item) => {
    const status = String(item.status ?? "").toLowerCase();
    return status === "failed" || status === "fail" || status === "error";
  });
  return {
    unmapped,
    failedUnmapped,
    unmappedEvidence: unmapped.length,
  };
}

/** Declared owners for which a full run produced no evidence key at all. */
export function findUnmatchedOwners(
  results,
  manifest,
  { normalizeOwner } = {}
) {
  const norm =
    typeof normalizeOwner === "function"
      ? normalizeOwner
      : (value) => String(value ?? "").replaceAll("\\", "/");
  const observed = new Set(
    (results ?? []).map((result) => norm(result?.owner)).filter(Boolean)
  );
  return [...collectRegisteredOwners(manifest)]
    .map(norm)
    .filter((owner) => owner && !observed.has(owner))
    .sort();
}

/**
 * Reconcile evidence-producing needs.* job conclusions against report summary.
 * When any needed job failed but summary.failed is 0, the report must not
 * present an implicit all-clear (#535 F5).
 *
 * @param {Record<string, { result?: string }>|null|undefined} needs GHA needs.* map (or job-conclusions.json).
 * @param {{ failed?: number }|null|undefined} summary Report evidence summary with failed count.
 * @param {{ evidenceJobs?: string[] }} [options] Optional allowlist of job names to consider.
 */
export function reconcileJobConclusions(needs, summary, options = {}) {
  const evidenceJobs = options.evidenceJobs ?? null;
  const failedJobs = [];
  for (const [job, info] of Object.entries(needs ?? {})) {
    if (evidenceJobs && !evidenceJobs.includes(job)) continue;
    const result = info?.result ?? info?.conclusion ?? info;
    if (result === "failure" || result === "failed") failedJobs.push(job);
  }
  failedJobs.sort();
  const evidenceFailed = Number(summary?.failed ?? 0);
  const silentAllClear = failedJobs.length > 0 && evidenceFailed === 0;
  return {
    failedJobs,
    silentAllClear,
    message: silentAllClear
      ? `Evidence-producing job(s) failed but report shows failed: 0 — ${failedJobs.join(", ")}`
      : null,
  };
}

/**
 * Ratchet cellsMissing vs the prior durable-history point (#535 F5).
 * historyPoints: oldest-first series *excluding* the current run.
 */
export function cellsMissingRatchet(currentMissing, historyPoints) {
  const current = Number(currentMissing ?? 0);
  const priorPoints = (historyPoints ?? []).filter(
    (point) => point != null && Number.isFinite(Number(point.cellsMissing))
  );
  if (!priorPoints.length) {
    return { prior: null, current, delta: 0, rose: false };
  }
  const prior = Number(priorPoints.at(-1).cellsMissing);
  const delta = current - prior;
  return { prior, current, delta, rose: delta > 0 };
}

/**
 * Identity-aware cell regression detection. Counts can stay flat while one
 * repaired cell is replaced by a newly-grey or newly-red cell.
 */
export function cellIdentityRegressions(
  { missingCellIds = [], failedCellIds = [] },
  historyPoints
) {
  const prior = (historyPoints ?? []).at(-1) ?? {};
  const priorMissing = new Set(prior.missingCellIds);
  const priorFailed = new Set(prior.failedCellIds);
  return {
    newMissing: [...new Set(missingCellIds)]
      .filter((id) => !priorMissing.has(id))
      .sort(),
    newFailed: [...new Set(failedCellIds)]
      .filter((id) => !priorFailed.has(id))
      .sort(),
  };
}

export * from "./report-depth-signals.mjs";
