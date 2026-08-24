// Pure row ordering for AutomationsOverviewScreen — extracted so the screen
// stays under the repo's component-file cap and the rule stays trivially
// unit-testable.
//
// There are no date-group helpers here (#765): "recent runs across
// everything" is ONE flat list in which every run states its own time, so there
// are no day buckets to label and no origin to split out of the meta string.

import type { AuOverviewRowDTO } from "../screen-contracts.js";

/** Attention / failed-last-run first, then alphabetical — so the list answers
 *  "what needs me?" before "what's everything named?" */
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
