// The pushed-shelf head: the frame's back affordance (chevron + the NAME of
// the destination, never the word "Back" — README §Cross-app
// standardisation) beside the shelf's own title. Shared by every shelf the
// More sheet reaches, and by the sibling's document screens.
//
// Both names are DERIVED (#1015): the head titles itself from the route it is
// on, and names its return target from the route beneath it on the stack
// (`docs-places.ts`). No call site types either, so none can disagree with the
// chevron.

import { useNavigation, useNavigationState } from "@react-navigation/native";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { TEST_IDS } from "../../kit/test-ids";
import { t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { DocsShellNavigation } from "../../navigation";
import { docsRouteTitle } from "./docs-places";

export default function DocsShelfHeader({
  title,
  trailing,
}: {
  /** Only when the screen knows a better name than its route does — a
   *  document's title once the read lands. Otherwise the route names itself. */
  title?: string;
  trailing?: React.ReactNode;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const navigation = useNavigation<DocsShellNavigation>();
  // The return target is READ off the stack, never passed in: the thirteen
  // call sites that used to pass it all said "All", whatever they sat behind.
  const stack = useNavigationState((state) => state);
  const routeTitle = docsRouteTitle(stack?.routes[stack.index]);
  const backTo = docsRouteTitle(
    stack && stack.index > 0 ? stack.routes[stack.index - 1] : undefined
  );
  const head = title ?? routeTitle;
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Back to ${backTo}`}
        onPress={() => navigation.goBack()}
        style={styles.back}
        // The label NAMES the destination, so it moves with the shelf a
        // member came from; the handle does not.
        testID={TEST_IDS.docs.breadcrumb}
      >
        <Icon name="chevron-left" size={22} color={colors.text} />
        <Text style={styles.backLabel}>{backTo}</Text>
      </Pressable>
      <Text numberOfLines={1} style={styles.title}>
        {head}
      </Text>
      {trailing}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    back: {
      alignItems: "center",
      flexDirection: "row",
      gap: 2,
      minHeight: 44,
      paddingEnd: 8,
    },
    backLabel: { ...t("control"), color: colors.text },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      minHeight: 44,
      paddingEnd: 18,
      paddingStart: 10,
    },
    title: { ...t("title"), color: colors.text, flex: 1, textAlign: "center" },
  });
