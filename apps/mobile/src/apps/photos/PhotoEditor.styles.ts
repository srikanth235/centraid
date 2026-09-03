import { StyleSheet } from "react-native";

import { radii, spacing, t } from "../../kit/theme";

export const EDITOR_MEDIA_HEIGHT = 300;

export const styles = StyleSheet.create({
  stage: {
    alignItems: "center",
    height: EDITOR_MEDIA_HEIGHT,
    justifyContent: "center",
    overflow: "hidden",
  },
  frame: { position: "relative" },
  mask: { position: "absolute" },
  cropBox: { borderWidth: 1, position: "absolute" },
  thirds: {
    borderStyle: "dashed",
    borderWidth: 1,
    bottom: "33.33%",
    insetInlineEnd: "33.33%",
    insetInlineStart: "33.33%",
    position: "absolute",
    top: "33.33%",
  },
  editBar: {
    alignItems: "center",
    borderTopWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
  },
  toolRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tool: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing[3],
  },
  toolLabel: { ...t("control") },
  note: { ...t("mono"), flexGrow: 1, flexShrink: 0, minWidth: 220 },
  commitRow: { flexDirection: "row", gap: spacing[2] },
  commit: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing[3],
  },
  refusal: { ...t("mono"), flexBasis: "100%" },
});
