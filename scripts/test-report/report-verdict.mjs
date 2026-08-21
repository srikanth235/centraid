/**
 * The verdict strip and the attention queue (#839 Wave 5, gaps G15/G16).
 *
 * Report v1 was an archive: every fact was on the page and the reader did the
 * grading. v2 opens with a verdict and a ranked queue — and the only way that
 * is trustworthy is if BOTH are computed from the same cell states, floors and
 * lanes the rest of the report already renders. Nothing here is hand-assigned,
 * nothing here takes a shortcut through a literal list of surfaces or lanes,
 * and nothing here invents a level the evidence does not support: with no run
 * evidence at all (a local `bun run test:report:smoke`, a PR-scope render), the
 * verdict is `no-evidence`, not a cheerful green.
 *
 * Everything in this module is pure over plain data, so the fixtures in
 * `report-verdict.test.mjs` can red a cell and watch the verdict flip.
 */

/**
 * States that mean "evidence ran and the product was wrong". `infra-mismatch`
 * rides with them because the report already treats it as a red cell (it is a
 * lane whose environment disagreed with its declaration, not an absence).
 */
export const RED_CELL_STATES = ["failed", "infra-mismatch"];

/**
 * States that mean "no live evidence for this cell tonight". `expected-grey`
 * is deliberately NOT here: #781 registers those as budgeted, named absences
 * with a tracking issue, and folding them in would drown the real greys.
 */
export const GREY_CELL_STATES = [
  "missing",
  "evidence-unmatched",
  "owner-silent",
  "lane-did-not-run",
];

/**
 * States worst first — the tiebreak inside one severity band. A cell that ran
 * and failed always outranks a cell that never ran, and a lane that started
 * and produced nothing (`owner-silent`) outranks one that never started, since
 * the first is a lane actively lying about its coverage.
 */
const STATE_ORDER = new Map(
  [
    "failed",
    "infra-mismatch",
    "evidence-unmatched",
    "owner-silent",
    "lane-did-not-run",
    "missing",
    "stale",
  ].map((state, index) => [state, index])
);

/** Severity bands, strongest first. Mirrors the #839 gap register's scale. */
export const SEVERITY_ORDER = ["S1", "S2", "S3", "S4"];

/**
 * Severity for one attention-queue entry, derived from the matrix's own data.
 *
 * There is no `severity` field in `tests/matrix.json` and there deliberately
 * is not one here either — a hand-assigned severity is a second opinion that
 * can drift from the grading. Instead the band is the product of two things
 * the matrix already says: what the cell CLAIMS (`surfaces[].assessment`, one
 * of solid/partial/gap/skip) and what tonight OBSERVED (the computed state).
 *
 *   S1  a cell the matrix calls `solid` is red — a proven promise broke
 *   S2  any other red cell, or a cell that had evidence last night and has
 *       none tonight (this is lane death, gap G15's whole subject)
 *   S3  a cell that was already grey, or whose evidence went stale
 *   S4  a standing finding pinned in a register and awaiting a decision
 *
 * @param {{assessment?: string, state: string, newlyGrey?: boolean, pinned?: boolean}} entry
 *   The queue entry: its matrix assessment, its observed state, whether it went
 *   grey since last night, and whether it is a pinned standing finding.
 * @returns {"S1"|"S2"|"S3"|"S4"} The severity band.
 */
export function severityFor(entry) {
  if (entry.pinned) return "S4";
  if (RED_CELL_STATES.includes(entry.state)) {
    return entry.assessment === "solid" ? "S1" : "S2";
  }
  if (entry.newlyGrey) return "S2";
  return "S3";
}

/**
 * Tracking-issue numbers a matrix note mentions, e.g. "Tracked under #781".
 * @param {string | undefined} note A `matrix.notes` entry.
 * @returns {number[]} Issue numbers, in the order the note names them.
 */
export function issueNumbersInNote(note) {
  return [...String(note ?? "").matchAll(/#(?<number>\d{2,6})\b/gu)].map(
    (match) => Number(match.groups.number)
  );
}

/**
 * Resolve a cell's tracking-issue hook from the matrix's own registers.
 * @param {object} cell A built report cell.
 * @param {object} matrix The parsed test matrix.
 * @returns {{number: number, url: string|null} | null} The hook, when named.
 */
function trackingHook(cell, matrix) {
  // A registered no-lane absence (#781) already carries its issue URL; every
  // other cell's hook is whatever its own matrix note cites.
  const registered = cell.expectedGrey?.issue ?? null;
  const number = issueNumbersInNote(
    registered ?? matrix.notes?.[`${cell.surface}.${cell.dimension}`]
  )[0];
  if (!Number.isFinite(number)) return null;
  return {
    number,
    url: matrix.trackingIssues?.[String(number)]?.url ?? registered,
  };
}

/**
 * Compute the verdict from the grading the report already did.
 *
 * The rule, in one sentence: no run evidence at all is `no-evidence`; any red
 * cell, unhandled error, failed job or under-floor scope is `red`; any grey
 * cell, stale evidence or flaky cell is `degraded`; everything else is
 * `shippable`. Each level carries the reasons that produced it, so the strip
 * can say WHY rather than only WHAT.
 *
 * @param {object} input The grading the rest of the report already did.
 * @param {object[]} input.cells Built report cells.
 * @param {object} input.summary The report summary block.
 * @param {number} input.evidenceCount How many evidence items were collected.
 * @param {string[]} [input.coverageBelowFloor] Scopes under their line floor.
 * @param {object[]} [input.mutationRows] Mutation rows with `score`/`floor`.
 * @returns {{level: string, label: string, reasons: string[], counts: object}}
 *   The computed level, its human label, why it landed there, and the counts.
 */
export function computeVerdict({
  cells = [],
  summary = {},
  evidenceCount = 0,
  coverageBelowFloor = [],
  mutationRows = [],
}) {
  const counts = {
    red: cells.filter((cell) => RED_CELL_STATES.includes(cell.state)).length,
    grey: cells.filter((cell) => GREY_CELL_STATES.includes(cell.state)).length,
    stale: cells.filter((cell) => cell.state === "stale").length,
    flaky: cells.filter((cell) => cell.state === "flaky").length,
    expectedGrey: cells.filter((cell) => cell.state === "expected-grey").length,
  };
  const mutationBelowFloor = mutationRows
    .filter(
      (row) =>
        Number.isFinite(row.score) &&
        Number.isFinite(row.floor) &&
        row.score < row.floor
    )
    .map((row) => row.scope);
  const reasons = [];
  if (counts.red) reasons.push(`${counts.red} red cell(s)`);
  if (summary.unhandledErrors)
    reasons.push(`${summary.unhandledErrors} unhandled error(s)`);
  if ((summary.failedJobs ?? []).length)
    reasons.push(`failed job(s): ${summary.failedJobs.join(", ")}`);
  if (coverageBelowFloor.length)
    reasons.push(`coverage under floor: ${coverageBelowFloor.join(", ")}`);
  if (mutationBelowFloor.length)
    reasons.push(`mutation under floor: ${mutationBelowFloor.join(", ")}`);
  const degradedReasons = [];
  if (counts.grey)
    degradedReasons.push(`${counts.grey} cell(s) with no evidence`);
  if (counts.stale) degradedReasons.push(`${counts.stale} stale cell(s)`);
  if (counts.flaky) degradedReasons.push(`${counts.flaky} flaky cell(s)`);

  if (!evidenceCount) {
    return {
      level: "no-evidence",
      label: "No run evidence",
      reasons: [
        "no lane reported a result into this render, so nothing here is a health claim",
      ],
      counts,
    };
  }
  if (reasons.length) {
    return { level: "red", label: "Red", reasons, counts };
  }
  if (degradedReasons.length) {
    return {
      level: "degraded",
      label: "Degraded",
      reasons: degradedReasons,
      counts,
    };
  }
  return {
    level: "shippable",
    label: "Shippable",
    reasons: ["every owned cell reported live evidence and passed"],
    counts,
  };
}

/**
 * Deltas between tonight's verdict counts and the most recent durable history
 * point. With no prior point the direction is `unknown` — the honest answer
 * for a first run, and never a flattering one.
 *
 * @param {{level: string, counts: object}} verdict Tonight's verdict.
 * @param {object[]} history Durable history points, oldest first, EXCLUDING
 *   tonight.
 * @returns {{priorLabel: string|null, priorLevel: string|null, direction: string, deltas: object}}
 *   Last night's label and level, which way tonight moved, and the per-count
 *   deltas that decided it.
 */
export function verdictDelta(verdict, history = []) {
  const prior = history.at(-1);
  if (!prior) {
    return {
      priorLabel: null,
      priorLevel: null,
      direction: "unknown",
      deltas: {},
    };
  }
  const priorCounts = {
    red: prior.cellsFailed,
    grey: prior.cellsMissing,
  };
  const deltas = {};
  for (const [key, priorValue] of Object.entries(priorCounts)) {
    if (!Number.isFinite(priorValue)) continue;
    deltas[key] = (verdict.counts[key] ?? 0) - priorValue;
  }
  const worse = Object.values(deltas).some((value) => value > 0);
  const better = Object.values(deltas).some((value) => value < 0);
  return {
    priorLabel: prior.label ?? null,
    priorLevel: prior.verdict ?? null,
    direction: worse ? "regressed" : better ? "improved" : "unchanged",
    deltas,
  };
}

/**
 * Rank every red, newly-grey, still-grey and stale item into one queue.
 *
 * Ordering is (severity band, live before pinned, worst state, new before
 * carried-over, cell id) — the last term only so two otherwise identical
 * entries land in a stable order across runs, which is what makes the queue
 * diffable night to night.
 *
 * @param {object} input Tonight's cells plus the registers that rank them.
 * @param {object[]} input.cells Built report cells.
 * @param {object} input.matrix The parsed test matrix (notes + trackingIssues).
 * @param {string[]} [input.newlyGreyIds] Cell ids grey tonight, not last night.
 * @param {string[]} [input.newlyRedIds] Cell ids red tonight, not last night.
 * @param {object} [input.knownFindings] `scripts/fuzz/known-findings.json`.
 * @returns {object[]} Ranked entries.
 */
export function buildAttentionQueue({
  cells = [],
  matrix = {},
  newlyGreyIds = [],
  newlyRedIds = [],
  knownFindings = null,
}) {
  const newlyGrey = new Set(newlyGreyIds);
  const newlyRed = new Set(newlyRedIds);
  const entries = [];
  for (const cell of cells) {
    const isRed = RED_CELL_STATES.includes(cell.state);
    const isGrey = GREY_CELL_STATES.includes(cell.state);
    const isStale = cell.state === "stale";
    if (!isRed && !isGrey && !isStale) continue;
    const hook = trackingHook(cell, matrix);
    entries.push({
      id: cell.id,
      kind: isRed ? "red" : isStale ? "stale" : "grey",
      state: cell.state,
      assessment: cell.assessment ?? null,
      severity: severityFor({
        assessment: cell.assessment,
        state: cell.state,
        newlyGrey: newlyGrey.has(cell.id),
      }),
      title: `${cell.surfaceLabel} · ${cell.dimensionLabel}`,
      lane: cell.lane ?? null,
      owner: cell.owners?.[0]?.owner ?? null,
      owners: (cell.owners ?? []).map((owner) => owner.owner),
      isNew: newlyGrey.has(cell.id) || newlyRed.has(cell.id),
      pinned: false,
      trackingIssue: hook?.number ?? null,
      trackingUrl: hook?.url ?? null,
      why: isRed
        ? `evidence ran and failed (${cell.state})`
        : isStale
          ? "the newest evidence for this owner is older than the freshness window"
          : `no evidence tonight (${cell.state})`,
    });
  }
  for (const [id, finding] of Object.entries(knownFindings?.classes ?? {})) {
    entries.push({
      id,
      kind: "pinned-finding",
      state: finding.status ?? "open",
      assessment: null,
      severity: severityFor({ state: "pinned", pinned: true }),
      title: `Fuzz finding · ${id}`,
      lane: "fuzz-parsers",
      owner: finding.found ?? null,
      owners: finding.found ? [finding.found] : [],
      isNew: false,
      pinned: true,
      trackingIssue: Number.isFinite(Number(finding.issue))
        ? Number(finding.issue)
        : null,
      trackingUrl: matrix.trackingIssues?.[String(finding.issue)]?.url ?? null,
      why: finding.note ?? "reproduced finding awaiting a product decision",
    });
  }
  return entries.sort(rankAttention);
}

/** Deterministic queue ordering; see `buildAttentionQueue`. */
function rankAttention(left, right) {
  const bySeverity =
    SEVERITY_ORDER.indexOf(left.severity) -
    SEVERITY_ORDER.indexOf(right.severity);
  if (bySeverity) return bySeverity;
  const byPinned = Number(left.pinned) - Number(right.pinned);
  if (byPinned) return byPinned;
  const byState =
    (STATE_ORDER.get(left.state) ?? STATE_ORDER.size) -
    (STATE_ORDER.get(right.state) ?? STATE_ORDER.size);
  if (byState) return byState;
  const byNew = Number(right.isNew) - Number(left.isNew);
  if (byNew) return byNew;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The auto-file payload for the queue, in the shape
 * `scripts/ci/report-cell-delta.mjs` renders into the nightly tracking issue
 * that `scripts/ci/file-tracking-issue.mjs` opens or updates.
 *
 * Only S1/S2 entries and pinned findings ride into the issue body: S3 (an item
 * that was already grey last night) is already tracked by the issue the last
 * run filed, and re-listing it every night is how a tracking issue becomes
 * unreadable. The full queue stays on the page.
 *
 * @param {object[]} queue The ranked attention queue.
 * @param {number} [limit] Maximum entries to carry into the issue body.
 * @returns {object[]} Compact entries for `summary.json`.
 */
export function attentionQueueForIssue(queue, limit = 10) {
  return queue
    .filter((entry) => entry.severity === "S1" || entry.severity === "S2")
    .slice(0, limit)
    .map((entry) => ({
      id: entry.id,
      severity: entry.severity,
      kind: entry.kind,
      title: entry.title,
      owner: entry.owner,
      trackingIssue: entry.trackingIssue,
      why: entry.why,
    }));
}
