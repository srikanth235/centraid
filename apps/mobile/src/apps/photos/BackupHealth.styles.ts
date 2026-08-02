import { StyleSheet } from "react-native";

import { family } from "../../kit/theme";

export const styles = StyleSheet.create({
  content: { padding: 18, paddingBottom: 50 },
  error: { fontFamily: family.sansRegular, fontSize: 12, marginVertical: 5 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 50,
    paddingHorizontal: 14,
  },
  hero: { alignItems: "center", borderRadius: 16, borderWidth: 1, padding: 26 },
  heroValue: { fontFamily: family.sansBold, fontSize: 20, marginTop: 12 },
  meta: { fontFamily: family.sansRegular, fontSize: 13, marginTop: 5 },
  rule: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 52,
  },
  ruleLabel: { fontFamily: family.sansRegular, fontSize: 14 },
  safe: { flex: 1 },
  section: {
    fontFamily: family.monoBold,
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 6,
    marginTop: 26,
  },
  settings: {
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: 24,
    padding: 15,
  },
  settingsText: { fontFamily: family.sansMedium, fontSize: 14 },
  storage: { fontFamily: family.sansRegular, fontSize: 14, lineHeight: 20 },
  title: { fontFamily: family.sansBold, fontSize: 18 },
  warning: {
    alignItems: "flex-start",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
    padding: 14,
  },
  warningText: {
    flex: 1,
    fontFamily: family.sansMedium,
    fontSize: 13,
    lineHeight: 19,
  },
});
