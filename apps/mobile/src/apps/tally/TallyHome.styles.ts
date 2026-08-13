import { StyleSheet } from "react-native";

import { family, radii, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  amount: { fontFamily: family.sansMedium, fontSize: t("body").fontSize },
  chip: { borderRadius: radii.pill, paddingHorizontal: 14, paddingVertical: 8 },
  chips: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  code: {
    borderRadius: radii.md,
    borderWidth: 1,
    fontFamily: family.sansMedium,
    padding: 10,
    width: 58,
  },
  empty: { padding: 28, textAlign: "center" },
  expense: {
    alignItems: "center",
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  expenseCopy: { flex: 1 },
  form: {
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: 8,
    margin: 12,
    padding: 12,
  },
  groupInput: {
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 100,
    padding: 8,
  },
  header: { alignItems: "center", flexDirection: "row", gap: 12, padding: 16 },
  input: {
    borderRadius: radii.md,
    borderWidth: 1,
    flex: 1,
    minWidth: 80,
    padding: 10,
  },
  list: { gap: 8, padding: 12, paddingBottom: 80 },
  meta: { fontFamily: family.sansRegular, fontSize: t("mono").fontSize },
  modal: { borderRadius: radii.lg, gap: 12, margin: 24, padding: 18 },
  modalBackdrop: {
    flex: 1,
    justifyContent: "center",
  },
  personName: { fontFamily: family.sansMedium, fontSize: t("body").fontSize },
  row: { alignItems: "center", flexDirection: "row", gap: 8 },
  safe: { flex: 1 },
  share: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    marginHorizontal: 16,
    padding: 10,
  },
  save: {
    borderRadius: radii.lg,
    marginLeft: "auto",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  template: {
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: 7,
    minWidth: 210,
    padding: 11,
  },
  templates: { gap: 8, paddingHorizontal: 12, paddingVertical: 4 },
  title: { fontFamily: family.sansMedium, fontSize: t("display").fontSize },
});
