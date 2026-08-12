// The two facts true on EVERY route: which vault, and which gateway holds it.
//
// The Binding Layer puts them at the head of the stem, so that on desktop they
// are visible from every screen. Mobile has no stem — the band is capped at six
// tabs and none of them can carry a two-line lockup — so they live at the head
// of Home, which is the one screen every route returns to.
//
// This replaces the time-of-day greeting that used to sit here. A greeting is
// true for about four hours and says nothing about where you are; a member with
// two vaults on two gateways could not tell from the old header which one they
// were looking at, on the screen whose whole job is to show them what they own.
// The vault mark doubles as the vault SWITCH, so identity and "change identity"
// are one control rather than two.
//
// The gateway line is mono because it is an address, and an address is a
// numeric-register fact: it is scanned character by character, not read. When
// the gateway is unreachable it says so in `--net`, in place, on the same line
// — never a banner and never a badge.
//
// The head carries the compact band's two verbs (handoff :3480 "New chat and
// Search move to the head; a row of places must not carry a verb"): Search
// everything and New chat. Quick add/Capture is NOT one of them — it stays
// reachable from wherever it already was, because the band's rule is that a
// row of PLACES carries no verb, and the head mirrors exactly the two verbs
// the band itself would have carried, not a third.

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { iconChipFinish, radii } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, family, pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

/** The vault mark, :5363–5365 — 30×30, radius 8. Smaller than the old 34px
 *  pill: it is a wash-ground identity chip now, not a solid-filled avatar, and
 *  the lighter fill reads best at the app-icon-chip size rather than a full
 *  control height. */
const MARK = 30;

/** `NEWCHAT_ICON`, handoff :3446 — a speech bubble with a `+`. Drawn inline
 *  from the handoff's own path data rather than through the shared `Icon`
 *  registry: the registry (packages/design/src/icons.ts) has no
 *  message-square-plus glyph yet, and this file cannot add one — it owns only
 *  mobile's Home chrome. Inlining the exact handoff paths keeps the pixels
 *  faithful without reaching outside that boundary. */
const NEW_CHAT_PATHS = [
  "M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z",
  "M9 10h6M12 7v6",
];

function NewChatIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      {NEW_CHAT_PATHS.map((d) => (
        <Path
          key={d}
          d={d}
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

export interface VaultHeaderProps {
  /** The active vault's name, or `undefined` while nothing is paired yet. */
  vaultName: string | undefined;
  /** The gateway holding it — its host label, in the numeric register. */
  gatewayName: string | undefined;
  /** The vault's identity colour (a raw hex from the vault link), if it has one. */
  color: string | undefined;
  /** True when the gateway is not answering. Says so on the gateway line. */
  offline: boolean;
  onSwitchVault: () => void;
  onSearch: () => void;
  onNewChat: () => void;
}

/**
 * A vault with no name yet is a real state, not a blank.
 *
 * It happens between pairing a gateway and the enrolled vault resolving, and
 * for the whole of a fresh install. Both get copy that describes the state
 * rather than an empty lockup that reads as a failed render.
 */
const NO_VAULT = "No vault yet";
const NO_GATEWAY = "not connected to a gateway";

export default function VaultHeader({
  vaultName,
  gatewayName,
  color,
  offline,
  onSwitchVault,
  onSearch,
  onNewChat,
}: VaultHeaderProps): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const name = vaultName?.trim() || NO_VAULT;
  const hue = /^#[0-9a-fA-F]{6}$/u.test(color ?? "") ? color : colors.text;
  // The mark's ground is the same 13%/20% hue-over-surface wash every app icon
  // chip draws (`iconChipFinish`, shared with LauncherGrid/FirstMoves) — the
  // handoff's own `color-mix(in oklab, <hue> …%, transparent)` (:5365) lowered
  // to RN, which has no `color-mix()`.
  //
  // The initial is painted in the FULL hue rather than the handoff's solved
  // `-text` rung (`this.hueText`, :5364): that rung is derived per named
  // palette key (`paletteText` in packages/design/src/palette.ts) and is not
  // exported past the design package's barrel, so mobile — outside this
  // file's ownership — has no way to reach it for an arbitrary vault hex.
  // `FirstMoves.tsx`'s `MoveRow` already pairs `iconChipFinish`'s wash with its
  // own `markColor` (the full hue) for exactly this reason; this mark follows
  // the same established precedent rather than reinventing contrast maths.
  const finish = iconChipFinish(hue ?? colors.text, colors.bg, scheme);
  const gateway = gatewayName?.trim();
  const line = gateway
    ? offline
      ? `${gateway} · offline`
      : gateway
    : NO_GATEWAY;

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name} on ${line}. Switch vault`}
        onPress={onSwitchVault}
        style={({ pressed }) => [styles.lockup, pressed && styles.pressed]}
      >
        <View
          style={[styles.mark, { backgroundColor: finish.backgroundColor }]}
        >
          <Text style={[styles.markInitial, { color: finish.markColor }]}>
            {(name[0] ?? "?").toUpperCase()}
          </Text>
        </View>
        {/* `aria-label` on the container above is a REPLACEMENT, so the two
            lines below are decorative to assistive tech and are not read
            twice. */}
        <View style={styles.names} accessibilityElementsHidden>
          <Text numberOfLines={1} style={styles.vault}>
            {name}
          </Text>
          <Text numberOfLines={1} style={styles.gateway}>
            {line}
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search everything"
        onPress={onSearch}
        hitSlop={10}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      >
        <Icon name="Search" size={16} color={colors.textSoft} />
      </Pressable>
      {/* New chat, not Quick add — :3480 "New chat and Search move to the
          head" (the compact band's own two verbs). Filled only INSIDE the
          band (:3474); in the head it is outlined, the same as Search,
          because the route's own primary (Search everything on the title
          row) holds the one-filled-ink budget here. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New chat"
        onPress={onNewChat}
        hitSlop={10}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      >
        <NewChatIcon color={colors.textSoft} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Bounded, :5461–5463 — a 34×34 control with a hairline-strong border and
    // a transparent ground, not the borderless icon-on-nothing the head drew
    // before. `lineStrong` is the handoff's `t.line` (the darker of its two
    // rungs; its `t.lineS` is the RN `line` hairline — see the mapping this
    // file's finish/ground comment above works from).
    action: {
      alignItems: "center",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      height: 34,
      justifyContent: "center",
      width: 34,
    },
    gateway: { ...t("mono"), color: colors.textFaint },
    lockup: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      // Same 12 the row itself carries — RN has no single flex container for
      // all four of the lockup's children (mark, names, search, new chat) the
      // way the handoff's one CSS `gap` does, so the same value is repeated
      // on both of the two nested rows it takes to lay them out here.
      gap: 12,
    },
    mark: {
      alignItems: "center",
      // 8, static — the handoff's own value (:5363), not `iconChipRadius()`'s
      // 26%-of-size ratio: that function is for app icon chips, and the vault
      // mark is drawn at a size (30px) the ratio would round to 7.8, not 8.
      borderRadius: 8,
      height: MARK,
      justifyContent: "center",
      width: MARK,
    },
    // The display face at 15px, not the `display` role (27px) — the handoff's
    // `lockupMarkStyle` sets its own size, and no ramp rung already matches.
    markInitial: {
      fontFamily: family.serifRegular,
      fontSize: 15,
      lineHeight: 18,
    },
    names: { flex: 1 },
    pressed: { backgroundColor: colors.bgPress },
    row: {
      alignItems: "center",
      flexDirection: "row",
      // `mobileLockupStyle`, :5529 — ONE `gap: R.gap.m` (12) across all four
      // children of the lockup row, not the three-number fake (lockup gap +
      // paddingEnd + action marginStart) this used to be.
      gap: 12,
      // `mobileLockupStyle`, :5529-5530 — `padding: 12px 18px 8px`.
      paddingBottom: 8,
      // The shared page margin (R.margin.m, :3356) — one token, not a
      // literal repeated per screen.
      paddingHorizontal: pageMargin,
      paddingTop: 12,
    },
    vault: { ...t("smallStrong"), color: colors.text },
  });
