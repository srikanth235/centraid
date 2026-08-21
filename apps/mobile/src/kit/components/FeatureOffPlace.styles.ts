// Frame geometry for the switched-off-place wall. Deliberately the same
// margins and head row the gated places themselves use (Automations,
// Connectors), so arriving at the wall is the same page with one block in it.
//
// Colourless by the kit's convention: ink resolves at the call site from
// `useTheme()`, so one sheet serves both schemes.

import { StyleSheet } from "react-native";

import { pageMargin, spacing } from "../theme";

export const styles = StyleSheet.create({
  body: { paddingBottom: spacing[6], paddingHorizontal: pageMargin },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    paddingHorizontal: pageMargin,
  },
  headBar: { flex: 1, minWidth: 0 },
  page: { flex: 1 },
  safe: { flex: 1 },
});
