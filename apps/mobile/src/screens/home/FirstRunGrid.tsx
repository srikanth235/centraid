// Day one on the springboard (issue #708 A, "First-run").
//
// The grid is made of content, so on day one it has none. Eight empty content
// tiles would be eight identical rectangles saying nothing — the brief's answer
// is what-to-do copy over DASHED placeholders: the same eight apps, still
// tappable, drawn as outlines of what they will become rather than as failures.
//
// The dashes are load-bearing. A dashed border reads as "not filled in yet"
// where a solid one reads as "this is the finished thing, and it is empty", and
// it is the one visual difference between this treatment and the real grid —
// the geometry, the icon chips and the app names are identical, so the
// transition into a populated Home is a fill, not a re-layout.
//
// This is reached only when every readable tile has SETTLED and is empty (see
// `springboardState` in ./tile-model). A vault that is merely still loading, or
// whose replica is unreachable, gets the ordinary grid instead — day one is a
// claim about the vault, and an unanswered read has not earned it.

import * as Haptics from "expo-haptics";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  HOME_FIRST_RUN_BODY,
  HOME_FIRST_RUN_PLACEHOLDERS,
  HOME_FIRST_RUN_TITLE,
} from "@centraid/client/home-copy";
import { iconChipFinish, iconChipRadius, radii } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { t, useTheme } from "../../kit/theme";
import type { Scheme, ThemeColors } from "../../kit/theme";
import type { LauncherItem } from "./catalog";
import { TILE_EMPTY_COPY } from "./tile-model";

const CHIP_SIZE = 26;

export interface FirstRunGridProps {
  items: readonly LauncherItem[];
  onOpen: (item: LauncherItem) => void;
}

export default function FirstRunGrid({
  items,
  onOpen,
}: FirstRunGridProps): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View accessibilityLabel={`Your apps, ${HOME_FIRST_RUN_TITLE}`}>
      {/* One spelling for one state: desktop draws these same two sentences out
          of the same module (packages/client/src/home-copy.ts). */}
      <Text style={styles.lead}>{HOME_FIRST_RUN_TITLE}</Text>
      <Text style={styles.sub}>{HOME_FIRST_RUN_BODY}</Text>
      <View style={styles.grid}>
        {/* FOUR placeholders, not one per installed app — they are a picture of
            what Home becomes, not an inventory of what you own. */}
        {items.slice(0, HOME_FIRST_RUN_PLACEHOLDERS).map((item) => (
          <Placeholder
            key={item.meta.id}
            item={item}
            scheme={scheme}
            colors={colors}
            styles={styles}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onOpen(item);
            }}
          />
        ))}
      </View>
    </View>
  );
}

function Placeholder({
  item,
  scheme,
  colors,
  styles,
  onPress,
}: {
  item: LauncherItem;
  scheme: Scheme;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}): React.JSX.Element {
  const { meta } = item;
  const finish = iconChipFinish(meta.color, colors.bg, scheme);
  const copy = TILE_EMPTY_COPY[meta.id] ?? meta.desc;
  return (
    <View style={styles.slot}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${meta.name} — ${copy}`}
        onPress={onPress}
        style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      >
        <View style={styles.header}>
          <View
            style={[
              styles.chip,
              {
                backgroundColor: finish.backgroundColor,
                borderRadius: iconChipRadius(CHIP_SIZE),
              },
            ]}
          >
            <Icon name={meta.iconKey} size={15} color={finish.markColor} />
          </View>
          <Text numberOfLines={1} style={styles.name}>
            {meta.name}
          </Text>
        </View>
        <Text style={styles.copy}>{copy}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      // The one difference from a real tile, and the whole message.
      borderStyle: "dashed",
      borderWidth: 1,
      gap: 10,
      minHeight: 108,
      padding: 14,
    },
    chip: {
      alignItems: "center",
      height: CHIP_SIZE,
      justifyContent: "center",
      width: CHIP_SIZE,
    },
    copy: { ...t("control"), color: colors.textFaint },
    grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -5 },
    header: { alignItems: "center", flexDirection: "row", gap: 8 },
    lead: { ...t("title"), color: colors.text, marginBottom: 4 },
    name: { ...t("control"), color: colors.text, flex: 1 },
    pressed: { backgroundColor: colors.bgPress },
    slot: { paddingBottom: 12, paddingHorizontal: 5, width: "50%" },
    sub: { ...t("small"), color: colors.textSoft, marginBottom: 18 },
  });
