/**
 * Severity, declared rather than computed (#915 Wave 3).
 *
 * `tests/matrix.json` had no severity field and `report-verdict.mjs` inferred
 * one from the declared assessment of the cell. The ladder needs a severity
 * that says what is at stake, not how complete the grid is, so the claims file
 * declares it per claim row and the lane inherits the worst claim it owns.
 */

export const SEVERITIES = Object.freeze(["S1", "S2", "S3", "S4"]);

/** Worst first, so `sort` by rank puts the blocker at the top. */
export const SEVERITY_RANK = Object.freeze({ S1: 0, S2: 1, S3: 2, S4: 3 });

/**
 * The severity of a lane.
 *
 * A lane inherits the worst severity among the claim rows that name it. A lane
 * no claim names is S2 when it gates promotion (a silent wrongness nobody
 * declared is still a silent wrongness) and S4 when it is advisory.
 * `lanes[].severity` in the claims file overrides both.
 *
 * @param {{id: string, status?: string, severity?: string}} lane a lane registry entry
 * @param {object[]} claimRows every claim row in the claims file
 */
export function laneSeverity(lane, claimRows = []) {
  if (SEVERITIES.includes(lane?.severity)) return lane.severity;
  const owned = claimRows.filter((claim) => claim.lane === lane?.id);
  if (owned.length > 0) {
    return owned
      .map((claim) => claim.severity)
      .sort((left, right) => SEVERITY_RANK[left] - SEVERITY_RANK[right])
      .at(0);
  }
  return lane?.status === "advisory" ? "S4" : "S2";
}
