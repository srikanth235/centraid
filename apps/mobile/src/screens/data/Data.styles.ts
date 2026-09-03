import { StyleSheet } from "react-native";

import { borders, pageMargin, radii, spacing } from "../../kit/theme";

const BOTTOM_ROOM = 96;

const SHEET_TOP_ROOM = 120;

export const styles = StyleSheet.create({
  head: { paddingHorizontal: pageMargin },
  page: { flex: 1 },
  safe: { flex: 1 },
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
