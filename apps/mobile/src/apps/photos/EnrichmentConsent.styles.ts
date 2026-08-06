// Geometry and type for the enrichment consent surface. COLOURLESS on
// purpose, like PhotosLibrary.styles.ts: every colour comes from `useTheme()`
// at the call site, so one sheet serves light and dark.

import { StyleSheet } from "react-native";

import { borders, spacing, t } from "../../kit/theme";

export const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    borderRadius: 12,
    borderWidth: borders.hairline,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: spacing[4],
  },
  actionText: t("control"),
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    marginTop: spacing[3],
  },
  // The reading register: one paragraph a member reads once before answering.
  body: { ...t("reading"), marginBottom: spacing[4] },
  content: { padding: spacing[3], paddingBottom: spacing[6] * 2 },
  eyebrow: t("eyebrow"),
  fact: {
    borderBottomWidth: borders.hairline,
    // A transparent leading edge on EVERY fact, so flagging one with the `net`
    // rule changes its colour and not the row's width — the table must not
    // reflow around the most important line on the screen.
    borderLeftWidth: 2,
    borderLeftColor: "transparent",
    minHeight: 44,
    paddingVertical: spacing[2],
  },
  factFlagged: { paddingLeft: spacing[3] },
  factLabel: t("mono"),
  factValue: { ...t("mono"), marginTop: spacing[1] },
  // The one filled element on the surface (§18).
  filled: { borderColor: "transparent" },
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
  note: { ...t("small"), paddingHorizontal: spacing[1] },
  panel: {
    borderRadius: 16,
    borderWidth: borders.hairline,
    marginBottom: spacing[4],
    padding: spacing[4],
  },
  panelTitle: {
    ...t("title"),
    marginBottom: spacing[3],
    marginTop: spacing[2],
  },
  safe: { flex: 1 },
  status: {
    ...t("small"),
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[3],
  },
  title: t("title"),
  // Why an answer cannot be given right now, beside the control it is about.
  unavailable: { ...t("small"), marginTop: spacing[3] },
});
