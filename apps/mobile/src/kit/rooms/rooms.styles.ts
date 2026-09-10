// Geometry for the six rooms (#1015, S1). Colourless, like every kit sheet:
// ink resolves at the call site, so one style object serves both schemes.
//
// The gutter is `pageMargin` in every room. The audit counted 144 hand-typed
// horizontal insets under `apps/mobile/src`, disagreeing by up to 6pt between
// a header and the list beneath it in the same screen.

import { StyleSheet } from "react-native";

import { borders, pageMargin, spacing, t } from "../theme";

export const styles = StyleSheet.create({
  actionRow: {
    flexDirection: "row",
    gap: spacing[2],
    justifyContent: "flex-end",
    paddingHorizontal: pageMargin,
    paddingVertical: spacing[3],
  },
  backRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: pageMargin,
    paddingTop: spacing[2],
  },
  bar: {
    alignItems: "center",
    borderBottomWidth: borders.hairline,
    flexDirection: "row",
    gap: spacing[3],
    paddingBottom: spacing[3],
    paddingHorizontal: pageMargin,
    paddingTop: spacing[3],
  },
  barTitle: { ...t("bodyStrong"), flex: 1, minWidth: 0 },
  body: { flex: 1 },
  // The scrolling body of a system place. The gutter is the ROOM's — a place
  // whose header and list disagree by 4pt was the commonest audit finding.
  placeBody: {
    paddingBottom: spacing[6],
    padding: pageMargin,
    gap: spacing[4],
  },
  coverHead: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: pageMargin,
    paddingTop: spacing[2],
  },
  foot: { borderTopWidth: borders.hairline },
  headTrailing: { alignItems: "center", flexDirection: "row", gap: spacing[2] },
  room: { flex: 1 },
  sheet: {
    borderTopLeftRadius: spacing[4],
    borderTopRightRadius: spacing[4],
    borderWidth: borders.hairline,
    paddingBottom: spacing[6],
  },
  sheetBody: { paddingHorizontal: pageMargin, paddingTop: spacing[2] },
  sheetTitle: { ...t("title"), paddingHorizontal: pageMargin },
  scrim: { flex: 1 },
});
