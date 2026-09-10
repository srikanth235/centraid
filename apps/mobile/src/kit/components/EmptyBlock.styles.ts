// Geometry for the two empty states (#765, spec §8 `emptyBlock`).
//
// FIRST-RUN is the whole screen a member meets once: display rung, reading
// body, a filled commit. ROUTINE is one state of a screen that is usually
// populated (a consent surface with nothing waiting is the HEALTHY state) —
// title rung, body rung, a quiet outlined verb. Same block, two registers,
// because giving the routine case the first-run treatment turns "nothing is
// waiting on you" into an event.

import { StyleSheet } from "react-native";

import { pageMargin, spacing, t } from "../theme";

/** The reference's `max-width: 44ch` (first-run) and `52ch` (routine). React
 *  Native has no `ch`; these are those measures at the touch rungs. */
const FIRST_RUN_MEASURE = 340;
const ROUTINE_MEASURE = 420;

export const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: spacing[2], paddingTop: spacing[1] },
  body: t("body"),
  bodyFirstRun: t("reading"),
  // THE GUTTER IS THE BLOCK'S OWN (#1015, S5 — audit S5, docs/findings.md#3).
  // It had vertical padding and no horizontal padding, so an empty rendered
  // inside a full-bleed list — the common case, since a list's rows carry
  // their own inset — put its title hard against the screen edge while every
  // populated row beside it sat at `pageMargin`. Both registers take the same
  // gutter, because the difference between them is rung and measure, never
  // margin.
  block: {
    alignItems: "flex-start",
    gap: spacing[2],
    maxWidth: ROUTINE_MEASURE,
    paddingHorizontal: pageMargin,
    paddingVertical: spacing[6],
  },
  blockFirstRun: { gap: spacing[3], maxWidth: FIRST_RUN_MEASURE },
  title: t("title"),
  titleFirstRun: t("display"),
});
