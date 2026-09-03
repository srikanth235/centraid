import { StyleSheet } from "react-native";

import { spacing, t } from "../theme";

const NOTE_MEASURE = 520;

export const styles = StyleSheet.create({
  text: {
    ...t("body"),
    maxWidth: NOTE_MEASURE,
    paddingBottom: spacing[4],
    paddingTop: spacing[2],
  },
});
