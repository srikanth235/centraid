// Library's layout, kept out of the screen so the screen reads as data + routes.
//
// This sheet is COLOURLESS on purpose: every colour on Library comes from
// `useTheme()` at the call site, so one sheet serves light and dark without a
// second copy. What lives here is geometry (the spacing scale) and type (the
// ramp's roles via `t()`), neither of which changes with the scheme.

import { StyleSheet } from "react-native";

import { borders, spacing, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  // The grid is two FlashList columns, so each cell already owns half the
  // width; the 4pt inset on both sides is what produces the 8pt gutter between
  // them and, with `content`'s 12pt page padding, the 16pt page margin.
  albumCard: { paddingBottom: spacing[3], paddingHorizontal: spacing[1] },
  albumCover: { aspectRatio: 1.35, borderRadius: 12, width: "100%" },
  albumInput: {
    ...t("body"),
    borderRadius: 12,
    borderWidth: borders.hairline,
    marginTop: spacing[4],
    padding: spacing[3],
  },
  albumTitle: { ...t("smallStrong"), marginTop: spacing[2] },
  backdrop: { flex: 1 },
  content: { padding: spacing[3], paddingBottom: spacing[6] * 2 },
  create: {
    alignItems: "center",
    borderRadius: 12,
    marginTop: spacing[3],
    padding: spacing[3],
  },
  createText: t("control"),
  dialog: {
    borderRadius: 16,
    borderWidth: borders.hairline,
    insetInlineEnd: spacing[5],
    insetInlineStart: spacing[5],
    padding: spacing[5],
    position: "absolute",
    top: "34%",
  },
  dialogTitle: t("title"),
  empty: { ...t("small"), paddingVertical: spacing[4] },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: spacing[2],
  },
  headerBtn: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  icon: {
    alignItems: "center",
    borderRadius: 12,
    borderWidth: borders.hairline,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  /** Header/footer bands, inset to line up with the album cells' 4pt gutter. */
  pageSection: { paddingHorizontal: spacing[1] },
  row: {
    alignItems: "center",
    borderBottomWidth: borders.hairline,
    flexDirection: "row",
    minHeight: 64,
  },
  rowCopy: { flex: 1, marginStart: spacing[3], minWidth: 0 },
  /** Metas count things, and a numeral is mono everywhere in this system. */
  rowMeta: t("mono"),
  rowTitle: t("body"),
  section: {
    ...t("eyebrow"),
    marginBottom: spacing[1],
    marginTop: spacing[5],
  },
  title: t("title"),
});
