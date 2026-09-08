/**
 * The lane evidence contract (#915 Wave 3, contract C2).
 *
 * Every lane on rungs 2–5 writes exactly one `artifacts/evidence/<lane>.json`
 * describing what it proved on one candidate. The nightly report is a pure
 * function of a directory of these files plus `tests/claims.json`, so this
 * module is the only place the shape is defined: `write-evidence.mjs`
 * validates on write, `read-evidence.mjs` validates on read, and a file that
 * fails either check is an error the report renders — never a file that is
 * silently dropped.
 *
 * The vocabulary is deliberately four words. `passed` and `failed` are what a
 * lane observed; `parked` is a failure the parks ledger has already put a date
 * on, so it does not count toward the verdict; `no-evidence` is the honest
 * word for a lane that claimed cells and then said nothing. There is no
 * "flaky", no "stale" and no "partial" — a run either falsified the claim or
 * did not (#915 supersedes the twelve-state legend of #864).
 */

/** Bumped only when a field changes meaning; readers refuse a newer schema. */
export const EVIDENCE_SCHEMA_VERSION = 1;

/** The whole cell vocabulary. Nothing else may appear as a lane verdict. */
export const VERDICTS = Object.freeze([
  "passed",
  "failed",
  "parked",
  "no-evidence",
]);

/** Per-case verdicts. A case may be skipped; a lane may not. */
export const CASE_VERDICTS = Object.freeze(["passed", "failed", "skipped"]);

/** Platforms a lane can run against. `any` means the lane is host-agnostic. */
export const PLATFORMS = Object.freeze([
  "android",
  "ios",
  "web",
  "desktop",
  "linux",
  "macos",
  "gateway",
  "any",
]);

/** The rungs of the ladder that write evidence (rungs 0–1 are local hooks). */
export const RUNGS = Object.freeze([2, 3, 4, 5]);

const LANE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/u;

/** True when `value` parses as an ISO-8601 instant. */
function isInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** True when `value` is a finite, non-negative number. */
function isCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Collect the errors in one `cases[]` entry. */
function caseErrors(entry, index, push) {
  const at = `cases[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    push(`${at} must be an object`);
    return;
  }
  if (typeof entry.id !== "string" || entry.id.trim() === "") {
    push(`${at}.id must be a non-empty string`);
  }
  if (!CASE_VERDICTS.includes(entry.verdict)) {
    push(`${at}.verdict must be one of ${CASE_VERDICTS.join(" | ")}`);
  }
  if (!isCount(entry.durationMs)) {
    push(`${at}.durationMs must be a non-negative number`);
  }
  if (
    entry.attempts !== undefined &&
    !(isCount(entry.attempts) && entry.attempts >= 1)
  ) {
    push(`${at}.attempts must be a positive number when present`);
  }
}

/** Collect the errors in the `parked` block. */
function parkedErrors(parked, push) {
  if (parked === null || parked === undefined) return;
  if (typeof parked !== "object" || Array.isArray(parked)) {
    push("parked must be an object or null");
    return;
  }
  if (!DATE_PATTERN.test(String(parked.until ?? ""))) {
    push("parked.until must be a YYYY-MM-DD date");
  }
  if (!Number.isInteger(parked.issue) || parked.issue <= 0) {
    push("parked.issue must be a positive issue number");
  }
}

/** Collect the errors in the `tags` block. */
function tagErrors(tags, push) {
  if (tags === undefined) return;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) {
    push("tags must be an object");
    return;
  }
  for (const key of ["qualities", "surfaces"]) {
    const list = tags[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
      push(`tags.${key} must be an array of strings`);
    }
  }
}

/**
 * Validate one evidence object against the contract.
 * @param {unknown} obj the parsed contents of an evidence file
 * @returns {{ok: boolean, errors: string[]}} every problem, never just the first
 */
export function validateEvidence(obj) {
  /** @type {string[]} */
  const errors = [];
  const push = (message) => errors.push(message);

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["evidence must be a JSON object"] };
  }

  if (obj.schema !== EVIDENCE_SCHEMA_VERSION) {
    push(
      `schema must be ${EVIDENCE_SCHEMA_VERSION} (got ${JSON.stringify(obj.schema)})`
    );
  }
  if (typeof obj.lane !== "string" || !LANE_PATTERN.test(obj.lane)) {
    push("lane must be a GitHub job id (lower-case, [a-z0-9._-])");
  }
  if (!RUNGS.includes(obj.rung)) {
    push(`rung must be one of ${RUNGS.join(" | ")}`);
  }
  if (!PLATFORMS.includes(obj.platform)) {
    push(`platform must be one of ${PLATFORMS.join(" | ")}`);
  }
  if (
    obj.candidate !== null &&
    !SHA_PATTERN.test(String(obj.candidate ?? ""))
  ) {
    push("candidate must be a git sha or null");
  }
  if (!isInstant(obj.startedAt)) push("startedAt must be an ISO-8601 instant");
  if (!isInstant(obj.finishedAt))
    push("finishedAt must be an ISO-8601 instant");
  if (
    isInstant(obj.startedAt) &&
    isInstant(obj.finishedAt) &&
    Date.parse(obj.finishedAt) < Date.parse(obj.startedAt)
  ) {
    push("finishedAt must not precede startedAt");
  }
  if (!VERDICTS.includes(obj.verdict)) {
    push(`verdict must be one of ${VERDICTS.join(" | ")}`);
  }
  if (!isCount(obj.budgetMs)) push("budgetMs must be a non-negative number");
  if (!isCount(obj.durationMs))
    push("durationMs must be a non-negative number");

  if (Array.isArray(obj.cases)) {
    obj.cases.forEach((entry, index) => caseErrors(entry, index, push));
  } else {
    push("cases must be an array");
  }

  parkedErrors(obj.parked, push);
  tagErrors(obj.tags, push);

  if (obj.verdict === "parked" && !obj.parked) {
    push("a parked verdict must carry the park it is parked under");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The evidence file name for a lane. Lane ids are already filesystem-safe by
 * the pattern above; this exists so writer and reader cannot disagree.
 * @param {string} lane the lane id, already filesystem-safe by the id pattern
 */
export function evidenceFileName(lane) {
  return `${lane}.json`;
}
