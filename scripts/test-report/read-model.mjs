import {
  buildAttention,
  buildBlockers,
  buildSinceYesterday,
} from "./model/attention.mjs";
import { buildCoverageGrid, buildPromises } from "./model/grids.mjs";
import { buildLaneBoard } from "./model/lanes.mjs";
import { SEVERITY_RANK } from "./model/severity.mjs";

export const VERDICTS = Object.freeze(["HOLD", "DEGRADED", "SHIPPABLE"]);

export const VERDICT_RULES = Object.freeze({
  maxParks: 3,
  maxParkAgeDays: 30,
  ownedSlaHours: 24,
});

export function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.round((b - a) / 86_400_000)
    : null;
}

export function computeVerdict({ rows, parks, today }) {
  const reds = rows.filter((row) => row.verdict === "failed");
  const silentGating = rows.filter(
    (row) => row.verdict === "no-evidence" && row.status === "gating"
  );
  const reported = rows.filter((row) => row.verdict !== "no-evidence");
  const degraded = rows.filter(
    (row) => row.verdict === "degraded" || row.outOfBand
  );
  const blocking = reds.filter(
    (row) => row.severity === "S1" || row.severity === "S2"
  );
  const oldestPark = parks.reduce((oldest, park) => {
    const age = daysBetween(park.since ?? park.until, today);
    return age !== null && (oldest === null || age > oldest) ? age : oldest;
  }, null);

  const parkOverflow = parks.length > VERDICT_RULES.maxParks;
  const parkTooOld = parks.some(
    (park) =>
      (daysBetween(park.since ?? today, today) ?? 0) >
      VERDICT_RULES.maxParkAgeDays
  );

  let verdict = "SHIPPABLE";
  let why = "Every unparked lane passed and no series left its noise band.";
  let flip = null;

  if (reported.length === 0) {
    return {
      verdict: "HOLD",
      why: "No lane wrote evidence for this candidate — the run proved nothing, which is not the same as proving nothing broke.",
      flip: "make one gating lane write evidence → DEGRADED",
      blockers: 0,
      parks: parks.length,
      oldestParkDays: oldestPark,
    };
  }

  if (blocking.length > 0 || parkOverflow || parkTooOld) {
    verdict = "HOLD";
    if (blocking.length > 0) {
      const worst = [...blocking].sort(
        (left, right) =>
          SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
      )[0];
      why = `${blocking.length === 1 ? "One" : blocking.length} ${worst.severity} blocker: ${worst.lane} failed${worst.firstFailingCase ? ` on ${worst.firstFailingCase}` : ""}.`;
      flip = `fix or park ${worst.lane} → ${degraded.length > 0 ? "DEGRADED" : blocking.length > 1 ? "HOLD" : "SHIPPABLE"}`;
    } else if (parkOverflow) {
      why = `${parks.length} lanes are parked; more than ${VERDICT_RULES.maxParks} parks is itself a hold.`;
      flip = "unpark or fix one lane → DEGRADED";
    } else {
      why = `A park is ${oldestPark} days old; no park may outlive ${VERDICT_RULES.maxParkAgeDays} days.`;
      flip = "close or renew the oldest park → DEGRADED";
    }
  } else if (
    reds.length > 0 ||
    degraded.length > 0 ||
    silentGating.length > 0
  ) {
    verdict = "DEGRADED";
    const first = reds[0] ?? degraded[0] ?? silentGating[0];
    why =
      reds.length > 0
        ? `${reds.length} lane${reds.length === 1 ? "" : "s"} red at S3 or below, starting with ${first.lane}.`
        : degraded.length > 0
          ? `${degraded.length} lane${degraded.length === 1 ? "" : "s"} outside budget or band, starting with ${first.lane}.`
          : `${silentGating.length} gating lane${silentGating.length === 1 ? "" : "s"} wrote no evidence, starting with ${first.lane}.`;
    flip = `fix ${first.lane} → SHIPPABLE`;
  }

  return {
    verdict,
    why,
    flip,
    blockers: blocking.length,
    parks: parks.length,
    oldestParkDays: oldestPark,
  };
}

export function buildModel(input) {
  const {
    claims,
    derived = {},
    evidence = new Map(),
    evidenceErrors = [],
    previousEvidence = new Map(),
    candidate = null,
    history = [],
    generatedAt = "1970-01-01T00:00:00Z",
    run = {},
    scope = "nightly",
    budgetMinutes = 90,
    quality = {},
  } = input;

  const today = generatedAt.slice(0, 10);
  const laneRegistry = claims.lanes ?? [];
  const validationErrors = [...evidenceErrors];

  const registered = new Set(laneRegistry.map((lane) => lane.id));
  for (const lane of evidence.keys()) {
    if (!registered.has(lane)) {
      validationErrors.push(
        `evidence/${lane}.json names lane "${lane}", which no claims lane registry entry declares — register it or stop writing it (bun run lint:evidence-mapping)`
      );
    }
  }

  const board = buildLaneBoard({
    laneRegistry,
    evidence,
    previousEvidence,
    history,
    claims,
    today,
  });
  const parks = board.rows
    .filter((row) => row.parked)
    .map((row) => ({
      lane: row.lane,
      until: row.parked.until,
      issue: row.parked.issue,
      since: row.parkedSince ?? null,
      why: row.parkWhy ?? "",
    }));

  const verdict = computeVerdict({ rows: board.rows, parks, today });
  const blockers = buildBlockers({ rows: board.rows, today });
  const attention = buildAttention({
    rows: board.rows,
    today,
    sla: VERDICT_RULES.ownedSlaHours,
  });
  const since = buildSinceYesterday({
    rows: board.rows,
    previousEvidence,
    today,
  });

  const promises = buildPromises({ claims, evidence, laneRegistry });
  const coverage = buildCoverageGrid({ claims, derived, evidence });

  const minutesUsed = Math.round(
    [...evidence.values()].reduce(
      (total, entry) => total + (entry.durationMs ?? 0),
      0
    ) / 60_000
  );

  return {
    schema: 1,
    scope,
    night: today,
    generatedAt,
    run,
    candidate,
    budgetMinutes,
    minutesUsed,
    verdict,
    delta: {
      previousVerdict: history.at(-1)?.verdict ?? null,
      previousCandidate: candidate?.previousSha ?? null,
      newRed: since.newRed.length,
      newGreen: since.newGreen.length,
      newlyParked: since.newlyParked.length,
      expiring: since.expiring.length,
    },
    counts: board.counts,
    blockers,
    since,
    attention,
    lanes: board.rows,
    journeys: derived.journeys ?? [],
    alarm: quality.alarm ?? null,
    coverage,
    promises,
    adversaries: {
      seeds: derived.seeds ?? [],
      mutation: quality.mutation ?? [],
      fuzzTargets: derived.fuzzTargets ?? [],
      fuzz: quality.fuzz ?? [],
      engines: claims.engineRegistry ?? [],
    },
    trends: quality.trends ?? [],
    evidencePanels: {
      coverageFloors: quality.coverageFloors ?? [],
      ratchetCandidates: quality.ratchetCandidates ?? [],
      consentLedger: claims.consentLedger ?? [],
      joinLaws: claims.joinLaws ?? [],
      inventory: quality.inventory ?? {},
      parks,
      fieldObservations: quality.qualityOpen ?? [],
      naCells: claims.naCells ?? {},
    },
    vocabulary: claims.vocabulary,
    severity: claims.severity,
    validationErrors,
  };
}

export { laneSeverity, SEVERITY_RANK } from "./model/severity.mjs";
