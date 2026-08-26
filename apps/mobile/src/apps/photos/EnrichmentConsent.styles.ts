// Geometry and type for the enrichment consent surface's CHROME (header,
// status line, scroll padding) — the panels themselves moved to
// `kit/components/ConsentGate.styles.ts` (#712). COLOURLESS on
// purpose, like PhotosLibrary.styles.ts: every colour comes from `useTheme()`
// at the call site, so one sheet serves light and dark.

import { StyleSheet } from "react-native";

import { spacing, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  content: { padding: spacing[3], paddingBottom: spacing[6] * 2 },
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
  safe: { flex: 1 },
  status: {
    ...t("small"),
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[3],
  },
  title: t("title"),
});
