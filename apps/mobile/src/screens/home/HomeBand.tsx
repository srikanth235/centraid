// The bottom navigation band (issue #707 Phase 5, the Binding Layer) —
// replaces the floating "liquid-glass" GlassDock. Per the brief's invariant 1:
// up to 5 pinned apps plus a "More" item that opens All apps, every tab at
// least 44pt, never themed by an app, never scrolled away. The metaphor is
// tinted paper, not glass: no blur, no gloss, no drop shadow — this is why the
// band no longer reaches for GlassBar (blur is reserved for transient
// overlays like SearchOverlay, not persistent chrome).
//
// Assistant renders as an ORDINARY slot (issue #707 Decision §3): ink, not
// raised, not teal. It and "More" share the same bare-icon treatment Home
// itself uses (no hue, no tinted chip) — only an app with a registered
// identity hue earns the tinted 26%-radius chip.
//
// This is Home-only chrome, styled over the existing native-stack navigator
// rather than a `@react-navigation/bottom-tabs` bar: every app in this
// springboard model is a full-screen cover pushed FROM Home (App.tsx's
// COVER_OPTIONS), not a sibling tab route, so there is no "current tab" to
// track once a cover is open — the band simply isn't on screen then. Adopting
// bottom-tabs would mean restructuring every app screen into a tab root and
// losing the swipe-to-dismiss cover model wholesale, which is not a contained
// change; styling this component over the springboard is.

import * as Haptics from "expo-haptics";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { iconChipFinish, iconChipRadius } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { metrics, t, useTheme } from "../../kit/theme";
import type { Scheme, ThemeColors } from "../../kit/theme";
import type { BandTab } from "./band";

const CHIP_SIZE = 30;
const MORE_TAB: BandTab = {
  icon: "Grid",
  id: "more",
  installed: true,
  name: "More",
};

export interface HomeBandProps {
  tabs: readonly BandTab[];
  onOpen: (id: string) => void;
  onMore: () => void;
}

export default function HomeBand({
  tabs,
  onOpen,
  onMore,
}: HomeBandProps): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          tab={tab}
          scheme={scheme}
          colors={colors}
          styles={styles}
          onPress={() => {
            void Haptics.selectionAsync();
            onOpen(tab.id);
          }}
        />
      ))}
      <Tab
        tab={MORE_TAB}
        scheme={scheme}
        colors={colors}
        styles={styles}
        onPress={() => {
          void Haptics.selectionAsync();
          onMore();
        }}
      />
    </View>
  );
}

function Tab({
  tab,
  scheme,
  colors,
  styles,
  onPress,
}: {
  tab: BandTab;
  scheme: Scheme;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}): React.JSX.Element {
  const label = tab.installed
    ? tab.name
    : `${tab.name}, on your desktop — tap to pair`;
  const finish = tab.color
    ? iconChipFinish(tab.color, colors.bg, scheme)
    : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
    >
      {/* Not-yet-installed is a colour token on the leaf (icon + chip fill),
          never a container opacity — opacity composites every descendant and
          would silently invalidate the label's own contrast. */}
      {finish ? (
        <View
          style={[
            styles.chip,
            {
              backgroundColor: tab.installed
                ? finish.backgroundColor
                : colors.bgSunken,
              borderRadius: iconChipRadius(CHIP_SIZE),
            },
          ]}
        >
          <Icon
            name={tab.icon}
            size={18}
            color={tab.installed ? finish.markColor : colors.textFaint}
            strokeWidth={1.8}
          />
        </View>
      ) : (
        <View style={styles.chip}>
          <Icon
            name={tab.icon}
            size={20}
            color={tab.installed ? colors.textSoft : colors.textFaint}
            strokeWidth={1.7}
          />
        </View>
      )}
      <Text
        // ink2 (`textSoft`) is the floor for a navigation label — an
        // uninstalled tab recedes to it, never past it into ink3. The band is
        // the one surface a reader must be able to scan without looking.
        style={[styles.label, !tab.installed && { color: colors.textSoft }]}
        numberOfLines={1}
      >
        {tab.name}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    chip: {
      alignItems: "center",
      height: CHIP_SIZE,
      justifyContent: "center",
      width: CHIP_SIZE,
    },
    label: {
      ...t("control"),
      color: colors.textSoft,
      marginTop: 4,
    },
    tab: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      minHeight: metrics.row,
      paddingVertical: 6,
    },
    tabPressed: { opacity: 0.6 },
    wrap: {
      backgroundColor: colors.bg,
      borderTopColor: colors.line,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      paddingHorizontal: 4,
      paddingTop: 8,
    },
  });
