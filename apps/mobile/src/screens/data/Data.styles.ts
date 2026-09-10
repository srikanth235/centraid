// Geometry for the record sheet Data opens over itself (#765, spec §6/§11).
//
// The PLACE's own frame — safe area, head row, gutter and the scroll room the
// docked health line needs — moved to `SystemPlace` in #1015 Wave 2. What is
// left is the sheet, which is the one thing this screen still draws itself.
//
// Colourless: every ink comes from `useTheme()` at the call site.

import { StyleSheet } from "react-native";

import { borders, pageMargin, radii, spacing } from "../../kit/theme";

/** The record sheet leaves the top of the screen visible — it is an aside from
 *  a row, not a destination. */
const SHEET_TOP_ROOM = 120;

export const styles = StyleSheet.create({
  // The scrim fills the modal root rather than sharing it with the plate: two
  // `flex: 1` siblings would each take half the screen and the sheet would
  // start at the middle.
  scrim: { ...StyleSheet.absoluteFill },
  sheet: {
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderTopWidth: borders.hairline,
    flex: 1,
    marginTop: SHEET_TOP_ROOM,
  },
  sheetBody: { padding: pageMargin, paddingBottom: spacing[6] },
});
