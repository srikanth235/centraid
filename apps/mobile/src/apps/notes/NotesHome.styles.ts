import { StyleSheet } from "react-native";

import {
  borders,
  family,
  pageMargin,
  radii,
  spacing,
  t,
} from "../../kit/theme";

export const styles = StyleSheet.create({
  backlink: {
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    gap: 2,
    paddingHorizontal: spacing[3],
    paddingVertical: 9,
  },
  backlinkLabel: {
    fontFamily: family.sansMedium,
    fontSize: t("mono").fontSize,
  },
  backlinkMeta: {
    fontFamily: family.sansRegular,
    fontSize: t("mono").fontSize,
  },
  backlinks: { gap: 8, marginTop: 18 },
  body: {
    ...t("body"),
    minHeight: 280,
    paddingTop: 12,
    textAlignVertical: "top",
  },
  button: {
    alignItems: "center",
    borderRadius: radii.lg,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing[4],
  },
  buttonText: {
    fontFamily: family.sansMedium,
    fontSize: t("body").fontSize,
  },
  chip: {
    borderRadius: radii.pill,
    borderWidth: borders.hairline,
    paddingHorizontal: spacing[3],
    paddingVertical: 7,
  },
  chipText: {
    fontFamily: family.sansMedium,
    fontSize: t("mono").fontSize,
  },
  controls: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: pageMargin,
    paddingVertical: 12,
  },
  count: {
    fontFamily: family.sansRegular,
    fontSize: t("mono").fontSize,
    fontVariant: ["tabular-nums"],
  },
  editor: { paddingBottom: 24, paddingHorizontal: pageMargin },
  empty: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: spacing[6],
    paddingVertical: 72,
  },
  emptyBody: {
    ...t("body"),
    textAlign: "center",
  },
  emptyTitle: {
    fontFamily: family.sansMedium,
    fontSize: t("reading").fontSize,
  },
  field: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    flex: 1,
    fontFamily: family.sansRegular,
    fontSize: t("body").fontSize,
    minHeight: 44,
    paddingHorizontal: spacing[3],
  },
  fieldRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingVertical: 8,
  },
  iconButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  linkAction: {
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    paddingHorizontal: spacing[3],
    paddingVertical: 10,
  },
  linkMeta: {
    fontFamily: family.sansRegular,
    fontSize: t("control").fontSize,
    marginTop: 2,
  },
  linkTitle: {
    fontFamily: family.sansMedium,
    fontSize: t("mono").fontSize,
  },
  linkWrap: { gap: 7, marginTop: 16 },
  list: { paddingBottom: 110, paddingHorizontal: pageMargin },
  note: {
    borderBottomWidth: borders.hairline,
    gap: 6,
    paddingVertical: 17,
  },
  noteMeta: {
    fontFamily: family.sansRegular,
    fontSize: t("mono").fontSize,
  },
  notePreview: {
    ...t("small"),
  },
  noteTitle: {
    fontFamily: family.sansMedium,
    fontSize: t("reading").fontSize,
  },
  row: {
    alignItems: "center",
    borderBottomWidth: borders.hairline,
    flexDirection: "row",
    gap: 10,
    minHeight: 52,
    paddingVertical: 8,
  },
  rowMeta: {
    ...t("small"),
    marginTop: 2,
  },
  rowName: {
    fontFamily: family.sansMedium,
    fontSize: t("reading").fontSize,
  },
  rowOpen: { flex: 1, justifyContent: "center", minHeight: 44 },
  section: { gap: 4, paddingHorizontal: pageMargin, paddingVertical: 10 },
  sectionTitle: {
    fontFamily: family.sansMedium,
    fontSize: t("mono").fontSize,
  },
  subtitle: {
    fontFamily: family.sansRegular,
    fontSize: t("mono").fontSize,
    marginTop: 2,
  },
  title: {
    borderBottomWidth: borders.hairline,
    fontFamily: family.sansMedium,
    fontSize: t("title").fontSize,
    paddingBottom: 10,
    paddingTop: 12,
  },
});
