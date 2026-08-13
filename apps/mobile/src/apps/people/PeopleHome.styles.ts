// People's stylesheet, in its own file the way PhotoLightbox and LockerHome
// keep theirs. The row height here is load-bearing: `PERSON_ROW_HEIGHT` in
// PersonListRow.tsx must equal `person.height`, or the directory's
// `getItemLayout` places rows where they are not.

import { StyleSheet } from "react-native";

import { family, radii, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  add: {
    alignItems: "center",
    borderRadius: radii.lg,
    justifyContent: "center",
    width: 44,
  },
  addRow: { flexDirection: "row", gap: 8, padding: 12 },
  body: { flex: 1, flexDirection: "row" },
  channel: {
    alignItems: "center",
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  detail: { flex: 1.45 },
  detailContent: { gap: 10, padding: 12, paddingBottom: 80 },
  detailTitle: { fontFamily: family.sansMedium, fontSize: t("title").fontSize },
  directory: { flex: 1 },
  form: { borderRadius: radii.lg, borderWidth: 1, gap: 9, padding: 10 },
  header: { alignItems: "center", flexDirection: "row", gap: 12, padding: 16 },
  input: {
    borderRadius: radii.lg,
    borderWidth: 1,
    flex: 1,
    minWidth: 72,
    padding: 10,
  },
  kindRow: { gap: 16, paddingVertical: 4 },
  mergeEmpty: {
    fontFamily: family.sansRegular,
    fontSize: t("body").fontSize,
    padding: 24,
    textAlign: "center",
  },
  mergeSearch: {
    flexDirection: "row",
    paddingBottom: 8,
    paddingHorizontal: 12,
  },
  meta: {
    ...t("mono"),
  },
  // Height is pinned rather than derived from content: `getItemLayout` on the
  // directory list is only correct while every row is exactly this tall.
  person: {
    borderBottomWidth: 1,
    height: 60,
    justifyContent: "center",
    paddingHorizontal: 13,
  },
  personName: {
    ...t("bodyStrong"),
  },
  safe: { flex: 1 },
  save: {
    borderRadius: radii.lg,
    marginLeft: "auto",
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  switchRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  title: { fontFamily: family.sansMedium, fontSize: t("display").fontSize },
  warning: {
    fontFamily: family.sansMedium,
    fontSize: t("control").fontSize,
    marginTop: 3,
  },
});
