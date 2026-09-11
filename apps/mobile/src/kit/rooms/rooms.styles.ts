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
  // The room's own states — error, loading, empty — sit OUTSIDE any screen's
  // padded body, so they take the room gutter here, once. The block inside
  // (`PanelBlock`, `EmptyBlock`) carries none of its own.
  state: { flex: 1, paddingHorizontal: pageMargin },
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
    // A browsing sheet (all apps, the vaults) carries a list; without a
    // ceiling the sheet grows past the top of the screen and its scroller
    // never bounds. The body shrinks inside it, so the grabber, the title and
    // the action row stay visible while the list scrolls between them.
    maxHeight: "85%",
    borderTopLeftRadius: spacing[4],
    borderTopRightRadius: spacing[4],
    borderWidth: borders.hairline,
    paddingBottom: spacing[6],
  },
  sheetBody: {
    flexShrink: 1,
    paddingHorizontal: pageMargin,
    paddingTop: spacing[2],
  },
  sheetTitle: { ...t("title"), paddingHorizontal: pageMargin },
  scrim: { flex: 1 },
  selectionNote: {
    ...t("mono"),
    paddingHorizontal: pageMargin,
    paddingTop: spacing[2],
    textAlign: "center",
  },
});
