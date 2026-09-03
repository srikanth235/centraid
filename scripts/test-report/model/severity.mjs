export const SEVERITIES = Object.freeze(["S1", "S2", "S3", "S4"]);

export const SEVERITY_RANK = Object.freeze({ S1: 0, S2: 1, S3: 2, S4: 3 });

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
