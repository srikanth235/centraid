import { StyleSheet } from "react-native";

import { family } from "../../kit/theme";

export const styles = StyleSheet.create({
  albumCard: { width: "48%" },
  albumCover: { aspectRatio: 1.35, borderRadius: 10, width: "100%" },
  albumGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 10 },
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
  content: { padding: 18, paddingBottom: 60 },
  create: {
    alignItems: "center",
    borderRadius: 10,
    marginTop: 12,
    padding: 12,
  },
  createText: { color: "#fff", fontFamily: family.sansBold, fontSize: 14 },
  dialog: {
    borderRadius: 16,
    left: 28,
    padding: 20,
    position: "absolute",
    right: 28,
    top: "34%",
  },
  dialogTitle: { fontFamily: family.displayBold, fontSize: 19 },
  empty: { fontFamily: family.sansRegular, fontSize: 13, paddingVertical: 15 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 50,
    paddingHorizontal: 14,
  },
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
    fontFamily: family.monoBold,
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 4,
    marginTop: 24,
  },
  title: { fontFamily: family.displayBold, fontSize: 18 },
});
