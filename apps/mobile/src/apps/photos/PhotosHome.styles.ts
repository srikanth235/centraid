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

import {
  BAND_BORDER,
  BAND_HEIGHT,
  BAND_INSET,
  BAND_RADIUS,
  BAND_TOP_GAP,
} from "../../kit/band-surface";
import { family, pageMargin, t } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { BAND_CAPSULE_SIZE } from "./photos-band";

/** The gap between the selection bar's plates — the same value the band's own
 *  two plates sit apart by (`PhotosBand.tsx`'s `PLATE_GAP`), so the bar this
 *  replaces and the bar it becomes read as the same piece of furniture. */
const SELECTION_PLATE_GAP = 8;

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
    // Select is a WORD, not a 44-square icon target (issue #712) — so it takes
    // the same 44pt height and the text's own width plus a gutter, rather than
    // being squeezed into an icon's box.
    selectChip: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      paddingHorizontal: 8,
    },
    selectChipText: { ...t("control"), color: colors.text },
    // SELECTION BAR (iOS Photos parity, issue #712). Ground it takes over from
    // the band while a selection is live — same plate anatomy as
    // `PhotosBand.tsx`'s own two plates (opaque `bgElev`, `lineStrong` edge,
    // `BAND_RADIUS` corners, held BAND_INSET off the stage edges) rather than
    // a new kind of bar, because the thing the member sees replacing the band
    // has to read as the SAME piece of furniture wearing different labels.
    // Unlike the band, this row is not `flex:none` below the scroll region
    // itself — PhotosHome's `<View style={styles.body}>` is already the sole
    // `flex:1` sibling above whichever foot renders, band or bar, so no
    // second reservation is needed here.
    selectionBarRow: {
      alignItems: "stretch",
      backgroundColor: "transparent",
      flexDirection: "row",
      gap: SELECTION_PLATE_GAP,
      minHeight: BAND_HEIGHT,
      paddingHorizontal: BAND_INSET,
      paddingTop: BAND_TOP_GAP,
    },
    // The left/right round-ish chips — Add to album and Trash. Square footed
    // at the capsule's own 52pt so the two rows (band, bar) line up exactly
    // when a member's thumb moves from one to the other between taps.
    selectionChip: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      justifyContent: "center",
      width: BAND_CAPSULE_SIZE,
    },
    // The centre plate: the count, and only the count. `flex:1` the same way
    // the band's own tab-group plate is, so the three plates share the row
    // exactly as the band's two do.
    selectionCountPlate: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: BAND_BORDER,
      flex: 1,
      justifyContent: "center",
    },
    // Bold is the heaviest weight the ramp carries (`sansMedium`, see
    // `kit/theme/index.ts`) — there is no bolder rung to reach for.
    selectionCountText: {
      ...t("control"),
      color: colors.text,
      fontFamily: family.sansMedium,
    },
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
