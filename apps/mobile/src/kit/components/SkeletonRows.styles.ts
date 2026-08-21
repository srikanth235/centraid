// Geometry for the loading skeleton (#765, spec §10).
//
// It is the ROWS BLOCK's own geometry, deliberately: the container, the
// radius, the hairlines and the 44pt row are the same objects, because the
// whole promise of a skeleton is that nothing moves when the content arrives.

import { StyleSheet } from "react-native";

import { borders, metrics, radii, spacing } from "../theme";

/** The bone: 11pt tall, the height of a line of the annotation rung, at the
 *  sub-control radius. A layout dimension standing in for a line of text. */
const BONE_HEIGHT = 11;

export const styles = StyleSheet.create({
  block: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    marginTop: spacing[4],
    overflow: "hidden",
  },
  bone: { borderRadius: radii.sm, height: BONE_HEIGHT },
  row: {
    borderTopWidth: borders.hairline,
    justifyContent: "center",
    minHeight: metrics.row,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  rowFirst: { borderTopWidth: 0 },
});
