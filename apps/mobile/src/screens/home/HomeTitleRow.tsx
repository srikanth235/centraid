// Home's title row: the route's name, and the rule the scroll region starts
// under.
//
// "Home" is set in the TITLE role (appNameStyle, handoff :5536 — 500 20px/26px
// sans), not the display serif. The display face is reserved for a route's own
// content register — the day-one headline below it, a document's own title —
// and Home's own name is chrome, the same weight class the app bar draws every
// other route's name in.
//
// It carries NO controls. A filled "Search everything" and an outlined "All
// apps" here would each be the second copy of a control the frame already
// offers: Search is the magnifier in the vault lockup directly above this row
// (VaultHeader.tsx), and All apps is the band's **More** tab directly below it
// (HomeBand.tsx). Two chips spanning the width of the screen buy nothing but a
// shorter first preview, on the one screen whose whole argument is that you
// see your things before you see the apps holding them.
//
// So this row's filled-ink budget stays unspent on Home. That
// is deliberate: on a screen made of previews, the loudest thing should be a
// member's own photograph, not a word.

import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { borders, pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export const HOME_TITLE = "Home";

export default function HomeTitleRow(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{HOME_TITLE}</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Fixed chrome (outside the ScrollView, see Home.tsx), so this row
    // owns its own horizontal margin and the rule the handoff's app bar draws
    // beneath it (`appBarStyle`, :5532–5533) — the same rule the prototype's
    // scroll region starts flush under.
    row: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: 8,
      paddingBottom: 14,
      paddingHorizontal: pageMargin,
    },
    title: { ...t("title"), color: colors.text, flex: 1 },
  });
