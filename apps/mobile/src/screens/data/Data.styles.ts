// Geometry for the Data place (#765, spec §6/§11).
//
// The blocks carry their own geometry; what is left here is the page's frame —
// the margin the reference drops to `R.margin.m(18)` at phone width (which is
// `pageMargin`), the scroll room the docked health line and the floating home
// key need under the last block, and the record sheet's plate.
//
// Colourless: every ink comes from `useTheme()` at the call site.

import { StyleSheet } from "react-native";

import { borders, pageMargin, radii, spacing } from "../../kit/theme";

/** Room under the last block for the docked health line and the floating home
 *  key, so neither ever covers a row. Layout dimension, not a token. */
const BOTTOM_ROOM = 96;

/** The record sheet leaves the top of the screen visible — it is an aside from
 *  a row, not a destination. */
const SHEET_TOP_ROOM = 120;

export const styles = StyleSheet.create({
  head: { paddingHorizontal: pageMargin },
  page: { flex: 1 },
  // The scrim fills the modal root rather than sharing it with the plate: two
  // `flex: 1` siblings would each take half the screen and the sheet would
  // start at the middle.
  scrim: { ...StyleSheet.absoluteFill },
  scroll: {
    paddingBottom: BOTTOM_ROOM,
    paddingHorizontal: pageMargin,
  },
  sheet: {
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderTopWidth: borders.hairline,
    flex: 1,
    marginTop: SHEET_TOP_ROOM,
  },
  sheetBody: { padding: pageMargin, paddingBottom: spacing[6] },
});
