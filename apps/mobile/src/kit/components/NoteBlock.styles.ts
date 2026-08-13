// Geometry for the standing note under a block group (#765, spec §8
// `noteBlock`).

import { StyleSheet } from "react-native";

import { spacing, t } from "../theme";

/** The reference sets `max-width: 60ch`; React Native has no `ch`, and the
 *  measure it protects (a note is one paragraph, never a column of text) is a
 *  layout dimension rather than a token. 520pt is that measure at the touch
 *  body rung, and it is wider than any phone, so it only ever binds on a
 *  tablet. Layout constants are lint-legal; type, ink and rhythm are not. */
const NOTE_MEASURE = 520;

export const styles = StyleSheet.create({
  text: {
    ...t("body"),
    maxWidth: NOTE_MEASURE,
    paddingBottom: spacing[4],
    paddingTop: spacing[2],
  },
});
