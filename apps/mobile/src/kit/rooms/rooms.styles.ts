// Geometry for the seven rooms (#1015, S1). Colourless, like every kit sheet:
// ink resolves at the call site, so one style object serves both schemes.
//
// The gutter is `pageMargin` in every room. The audit counted 144 hand-typed
// horizontal insets under `apps/mobile/src`, disagreeing by up to 6pt between
// a header and the list beneath it in the same screen.

import { StyleSheet } from "react-native";

import { borders, pageMargin, radii, spacing, t, targetMin } from "../theme";

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
  // THE STAGE (R-NY-14). Full-bleed: no gutter and no safe-area padding on the
  // ground itself — the media runs under the notch, and only the chrome on it
  // is inset. Its ink is the theme's `stage`, resolved in the room.
  stage: { flex: 1 },
  // The room's own close key, when a caller brings no chrome: a lone opaque
  // plate at the head, at the touch floor, on the page gutter.
  stageHead: {
    flexDirection: "row",
    insetInlineEnd: 0,
    insetInlineStart: 0,
    paddingHorizontal: pageMargin,
    position: "absolute",
    top: spacing[2],
  },
  // `radii.pill` is the stage's own plate shape, not an avatar rung: every
  // floating control on a stage is a chip on a photograph. `coarse`, because
  // a stage is only ever touched.
  stageClose: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: borders.hairline,
    justifyContent: "center",
    minHeight: targetMin.coarse,
    minWidth: targetMin.coarse,
  },
  selectionNote: {
    ...t("mono"),
    paddingHorizontal: pageMargin,
    paddingTop: spacing[2],
    textAlign: "center",
  },
});
