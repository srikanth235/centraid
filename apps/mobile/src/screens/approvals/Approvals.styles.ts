import { StyleSheet } from "react-native";

import {
  borders,
  metrics,
  pageMargin,
  radii,
  spacing,
  t,
} from "../../kit/theme";

const INPUT_TALL = 104;

export const styles = StyleSheet.create({
  actionError: { ...t("mono"), paddingBottom: spacing[2] },
  body: { paddingBottom: spacing[6], paddingHorizontal: pageMargin },
  detailActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    paddingTop: spacing[2],
  },
  detailText: t("mono"),
  factKey: t("eyebrow"),
  field: { gap: spacing[1] },
  form: { gap: spacing[3], paddingTop: spacing[2] },
  formActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: pageMargin,
  },
  headBar: { flex: 1, minWidth: 0 },
  input: {
    ...t("body"),
    borderRadius: radii.sm,
    borderWidth: borders.hairline,
    minHeight: metrics.controlTouch,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  inputTall: { minHeight: INPUT_TALL, textAlignVertical: "top" },
  page: { flex: 1 },
  safe: { flex: 1 },
  toggleRow: { alignItems: "flex-start", paddingTop: spacing[1] },
});
