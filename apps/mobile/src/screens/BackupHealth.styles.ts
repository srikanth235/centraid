import { StyleSheet } from "react-native";

import { borders, spacing, t } from "../kit/theme";

export const styles = StyleSheet.create({
  // The consent moment's geometry mirrors EnrichmentConsent.styles.ts on
  // purpose: one consent grammar, whichever surface is asking (#711, S4).
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
  body: { ...t("reading"), marginBottom: spacing[4] },
  content: { padding: spacing[4] + 2, paddingBottom: spacing[6] + 18 },
  error: { ...t("control"), marginVertical: spacing[1] + 1 },
  eyebrow: t("eyebrow"),
  fact: {
    borderBottomWidth: borders.hairline,
    // A transparent leading edge on EVERY fact, so flagging one with the `net`
    // rule changes its colour and not the row's width — the table must not
    // reflow around the most important line on the screen.
    borderLeftColor: "transparent",
    borderLeftWidth: 2,
    minHeight: 44,
    paddingVertical: spacing[2],
  },
  factFlagged: { paddingLeft: spacing[3] },
  factLabel: t("mono"),
  factValue: { ...t("mono"), marginTop: spacing[1] },
  /** The one filled element on the surface (§18). */
  filled: { borderColor: "transparent" },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    minHeight: 50,
    paddingHorizontal: spacing[4] - 2,
  },
  headerCopy: { flex: 1 },
  hero: {
    alignItems: "center",
    borderRadius: 16,
    borderWidth: 1,
    padding: spacing[5] + 2,
  },
  // The failing hero takes a 2px `net` rule on its leading edge and NOTHING
  // else — never a fill, never a red plate (§18). The other two states leave
  // this edge transparent so the card does not reflow between verdicts.
  heroFlagged: { borderLeftWidth: 2, paddingLeft: spacing[5] },
  heroValue: { ...t("bodyStrong"), marginTop: spacing[3] },
  meta: { ...t("control"), marginTop: spacing[1] + 1 },
  note: { ...t("small"), marginBottom: spacing[2] },
  panel: {
    borderRadius: 16,
    borderWidth: borders.hairline,
    marginTop: spacing[4],
    padding: spacing[4],
  },
  panelTitle: {
    ...t("title"),
    marginBottom: spacing[3],
    marginTop: spacing[2],
  },
  rule: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 52,
  },
  // The `never` switch's row, flagged the same way a `net` fact is.
  ruleFlagged: { borderLeftWidth: 2, paddingLeft: spacing[3] },
  ruleLabel: { ...t("body"), flex: 1 },
  safe: { flex: 1 },
  section: {
    ...t("eyebrow"),
    marginBottom: spacing[1] + 2,
    marginTop: spacing[6] - 6,
  },
  settings: {
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing[2] + 2,
    marginTop: spacing[6],
    padding: spacing[3] + 3,
  },
  settingsText: t("smallStrong"),
  subtitle: { ...t("small"), marginTop: 2 },
  title: t("bodyStrong"),
  /** Why something cannot happen right now, beside the control it is about. */
  unavailable: { ...t("small"), marginTop: spacing[3] },
});
