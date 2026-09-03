import { StyleSheet } from "react-native";

import { spacing, t } from "../theme";

const FIRST_RUN_MEASURE = 340;
const ROUTINE_MEASURE = 420;

export const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: spacing[2], paddingTop: spacing[1] },
  body: t("body"),
  bodyFirstRun: t("reading"),
  block: {
    alignItems: "flex-start",
    gap: spacing[2],
    maxWidth: ROUTINE_MEASURE,
    paddingVertical: spacing[6],
  },
  blockFirstRun: { gap: spacing[3], maxWidth: FIRST_RUN_MEASURE },
  title: t("title"),
  titleFirstRun: t("display"),
});
