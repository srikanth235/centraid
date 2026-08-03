import { StyleSheet } from "react-native";

import { family } from "../../kit/theme";

export const styles = StyleSheet.create({
  // The grid is two FlashList columns, so each cell already owns half the
  // width; the 6pt inset on both sides is what produces the 12pt gutter between
  // them and, with `content`'s 12pt page padding, the 18pt page margin.
  albumCard: { paddingBottom: 14, paddingHorizontal: 6 },
  albumCover: { aspectRatio: 1.35, borderRadius: 10, width: "100%" },
  albumTitle: { fontFamily: family.sansMedium, fontSize: 13, marginTop: 7 },
  albumInput: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: family.sansRegular,
    fontSize: 15,
    marginTop: 18,
    padding: 12,
  },
  backdrop: { backgroundColor: "rgba(0,0,0,.4)", flex: 1 },
  content: { padding: 12, paddingBottom: 60 },
  create: {
    alignItems: "center",
    borderRadius: 10,
    marginTop: 12,
    padding: 12,
  },
  createText: { color: "#fff", fontFamily: family.sansMedium, fontSize: 14 },
  dialog: {
    borderRadius: 16,
    left: 28,
    padding: 20,
    position: "absolute",
    right: 28,
    top: "34%",
  },
  dialogTitle: { fontFamily: family.sansMedium, fontSize: 19 },
  empty: { fontFamily: family.sansRegular, fontSize: 13, paddingVertical: 15 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 50,
    paddingHorizontal: 14,
  },
  /** Header/footer bands, inset to line up with the album cells' 6pt gutter. */
  pageSection: { paddingHorizontal: 6 },
  icon: {
    alignItems: "center",
    borderRadius: 10,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  row: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    minHeight: 64,
  },
  rowCopy: { flex: 1, marginLeft: 12 },
  rowMeta: { fontFamily: family.sansRegular, fontSize: 12, marginTop: 3 },
  rowTitle: { fontFamily: family.sansMedium, fontSize: 14 },
  safe: { flex: 1 },
  section: {
    fontFamily: family.monoMedium,
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 4,
    marginTop: 24,
  },
  title: { fontFamily: family.sansMedium, fontSize: 18 },
});
