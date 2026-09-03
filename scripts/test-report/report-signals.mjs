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
    cellsExpectedGrey: 0,
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
    if (cell.state === "expected-grey") counts.cellsExpectedGrey += 1;
  }
  return counts;
}

const EVIDENCE_SEVERITY = [
  "infra-mismatch",
  "failed",
  "flaky",
  "stale",
  "missing",
  "skipped",
  "passed",
];

function evidenceSeverityRank(status) {
  const rank = EVIDENCE_SEVERITY.indexOf(String(status ?? ""));
  return rank === -1 ? EVIDENCE_SEVERITY.indexOf("missing") : rank;
}

export function worstEvidenceByOwner(items, { normalizeOwner } = {}) {
  const norm =
    typeof normalizeOwner === "function"
      ? normalizeOwner
      : (value) => String(value ?? "").replaceAll("\\", "/");
  const byOwner = new Map();
  for (const item of items ?? []) {
    const owner = norm(item?.owner);
    if (!owner) continue;
    const current = byOwner.get(owner);
    if (
      !current ||
      evidenceSeverityRank(item.status) < evidenceSeverityRank(current.status)
    ) {
      byOwner.set(owner, item);
    }
  }
  return byOwner;
}

export function applyExpectedGrey(cells, registrations, laneMarkers = {}) {
  const reclassifiable = new Set([
    "missing",
    "owner-silent",
    "lane-did-not-run",
  ]);
  const applied = [];
  const expectedAbsentOwners = new Set();
  const byCellId = new Map();
  for (const registration of registrations ?? []) {
    if (laneMarkers[registration.lane]) continue; // lane exists — void
    for (const id of registration.cells ?? []) byCellId.set(id, registration);
    if (registration.owner) expectedAbsentOwners.add(registration.owner);
  }
  const next = (cells ?? []).map((cell) => {
    const registration = byCellId.get(cell.id);
    if (!registration || !reclassifiable.has(cell.state)) return cell;
    applied.push(cell.id);
    return {
      ...cell,
      state: "expected-grey",
      expectedGrey: {
        lane: registration.lane,
        issue: registration.issue,
        reason: registration.reason,
      },
    };
  });
  return { cells: next, applied: applied.sort(), expectedAbsentOwners };
}

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
          classifications.includes("skipped") ||
          (attempts.length &&
            attempts.every((attempt) => attempt.status === "skipped"))
        ) {
          status = "skipped";
        } else if (
          classifications.includes("expected") ||
          attempts.some((attempt) => attempt.status === "passed")
        ) {
          status = "passed";
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

export function detectDefaultCiEnvGate(source) {
  if (typeof source !== "string" || !source.trim()) return null;
  const skipIfNeq = source.match(
    /describe\.skipIf\(\s*process\.env\.(?<env>[A-Z0-9_]+)\s*!==\s*['"]1['"]\s*\)/u
  );
  if (skipIfNeq)
    return { env: skipIfNeq.groups?.env, kind: "skipIf-env-not-1" };
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
          // Intentionally empty.
        }
        return undefined;
      }
    )
  );
  return rows.filter((row) => row !== undefined);
}

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

export function findUnmatchedOwners(
  results,
  manifest,
  { normalizeOwner, ignoreOwners } = {}
) {
  const norm =
    typeof normalizeOwner === "function"
      ? normalizeOwner
      : (value) => String(value ?? "").replaceAll("\\", "/");
  const observed = new Set(
    (results ?? []).map((result) => norm(result?.owner)).filter(Boolean)
  );
  const ignored = new Set([...(ignoreOwners ?? [])].map(norm));
  return [...collectRegisteredOwners(manifest)]
    .map(norm)
    .filter((owner) => owner && !observed.has(owner) && !ignored.has(owner))
    .sort();
}

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
