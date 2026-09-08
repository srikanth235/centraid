// THE IMPORTANT-DATE WRITE OPERATION (#996, ruling R21; drift ONT-26).
//
// `people.add_important_date` refused February 31 in its input schema — a
// regular expression naming the length of every month. `atlas.insert_row`
// wrote it, because the table's only CHECK was `length(month_day) = 5`. The
// same fact about the calendar, enforced in one writer and not the other, is
// exactly the shape ONT-26 filed.

import type { DatabaseSync } from "node:sqlite";

import { classifyTemporal } from "@centraid/core/time";

export interface ImportantDateDraft {
  readonly dateId: string | null;
  readonly monthDay?: string | null | undefined;
}

export interface ImportantDateCondition {
  readonly name: string;
  readonly assert: (
    vault: DatabaseSync,
    draft: ImportantDateDraft
  ) => string | null;
}

export const IMPORTANT_DATE_CONDITIONS: readonly ImportantDateCondition[] = [
  {
    name: "important_date_is_a_real_day",
    assert: (vault, draft) => {
      let monthDay = draft.monthDay;
      if (monthDay === undefined) {
        if (draft.dateId === null) return null;
        const row = vault
          .prepare(
            "SELECT month_day FROM people_important_date WHERE date_id = ?"
          )
          .get(draft.dateId) as { month_day: string } | undefined;
        monthDay = row?.month_day ?? null;
      }
      if (monthDay === null) {
        return draft.dateId === null
          ? "An important date needs a month and a day."
          : null;
      }
      // A yearless anniversary: the 29th of February is a real one, the 31st
      // is not, and neither answer depends on which year it is read in.
      return classifyTemporal(monthDay) === "month-day"
        ? null
        : `month_day: ${JSON.stringify(monthDay)} is not a day of the year — an anniversary is MM-DD, and that day does not exist.`;
    },
  },
];

export function assertImportantDateWrite(
  vault: DatabaseSync,
  draft: ImportantDateDraft
): { condition: string; message: string } | null {
  for (const condition of IMPORTANT_DATE_CONDITIONS) {
    const message = condition.assert(vault, draft);
    if (message !== null) return { condition: condition.name, message };
  }
  return null;
}
