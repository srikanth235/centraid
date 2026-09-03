import type { AuOverviewRowDTO } from "../screen-contracts.js";

export function sortOverviewRows(
  rows: readonly AuOverviewRowDTO[]
): AuOverviewRowDTO[] {
  return [...rows].sort((a, b) => {
    const aAtt = a.attentionCount > 0 || a.lastRunOk === false ? 1 : 0;
    const bAtt = b.attentionCount > 0 || b.lastRunOk === false ? 1 : 0;
    if (aAtt !== bAtt) return bAtt - aAtt;
    if (a.attentionCount !== b.attentionCount)
      return b.attentionCount - a.attentionCount;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
