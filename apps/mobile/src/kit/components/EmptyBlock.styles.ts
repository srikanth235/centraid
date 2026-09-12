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
  // NO GUTTER OF ITS OWN (#1015, Round NY). The gutter is the CONTAINER's:
  // a room's empty state (`RoomBody`) and a system place's body
  // (`placeBody`) already pad with `pageMargin`, and a block that padded too
  // drew its title at twice the margin of the header above it. A caller that
  // renders the block into a full-bleed list pads the list, as it does for
  // the rows the list would otherwise hold.
  block: {
    alignItems: "flex-start",
    gap: spacing[2],
    maxWidth: ROUTINE_MEASURE,
    paddingVertical: spacing[6],
  },
  blockFirstRun: { gap: spacing[3], maxWidth: FIRST_RUN_MEASURE },
  // `inset`: the caller's container is a full-bleed list, whose rows carry
  // their own gutter, so the block brings the page gutter with it.
  inset: { paddingHorizontal: pageMargin },
  title: t("title"),
  titleFirstRun: t("display"),
});
