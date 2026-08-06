// Photos' home layout (issue #712 P18, extracted from ./PhotosHome).
//
// THE SEAM. `PhotosHome.tsx`'s own header calls the screen "the wiring: state,
// data and routing" and lists the seven modules already pulled out of it on
// exactly that principle. The sheet was the one piece still in the file that
// is neither state, data nor a route — so it follows the same rule, into the
// `.styles.ts` sibling this directory keeps for PhotoLightbox, PhotosLibrary,
// PhotoEditor, FaceReview and AlbumDetail.
//
// Colour-taking (a factory over `ThemeColors`, memoised at the call site)
// rather than colourless, because the head's hairline and the scroll region's
// ground are colour decisions, not geometry.

import { StyleSheet } from "react-native";

import { pageMargin, t } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // The scroll region takes what is left after the head and the band; the
    // band takes its own height. No absolute slot, and so nothing to reserve.
    body: { flex: 1 },
    bodyText: {
      ...t("body"),
      color: colors.textSoft,
      marginTop: 12,
      maxWidth: 290,
      textAlign: "center",
    },
    center: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: 28,
    },
    emptyTitle: { ...t("display"), color: colors.text },
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      // 56px (handoff `appBarStyle` :5533's `min-height:56px`).
      minHeight: 56,
      paddingHorizontal: pageMargin,
    },
    headerActions: { flexDirection: "row" },
    headerBtn: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    safe: { flex: 1 },
    selectionCount: { ...t("mono"), color: colors.text },
    // The title starts at the page margin now that no ☰ occupies the leading
    // slot; `header`'s own `paddingHorizontal: pageMargin` is that margin, so
    // the title needs no margin of its own — it used to add `spacing[2]` on
    // top of a header padding that was only an approximation (`10`) of the
    // page margin, which happened to sum to 18; now that `header` carries the
    // real token, adding `spacing[2]` again would push the title past it.
    title: { ...t("title"), color: colors.text },
    uploadFill: { borderRadius: 999, height: "100%" },
    uploadProgress: { gap: 5, paddingHorizontal: 16, paddingVertical: 8 },
    uploadProgressText: { ...t("mono"), color: colors.textSoft },
    uploadTrack: {
      backgroundColor: colors.line,
      borderRadius: 999,
      height: 5,
      overflow: "hidden",
    },
  });
