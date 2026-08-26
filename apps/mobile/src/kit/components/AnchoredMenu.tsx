// Anchored menu — a card hanging off the control, never a sheet (#712).
// Kit-owned plate (`band-surface.ts`). Opaque, never glass: contrast cannot
// depend on what was photographed. One nesting level in the same card
// (leading ‹ row), no stacked second card. No shadow: surfaces separate by
// edge (§G).

import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import type { View as RNView } from "react-native";

import { BAND_INSET, BAND_RADIUS } from "../band-surface";
import { borders, spacing, t, useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import Icon from "./Icon";
import { Text } from "./NativeText";

/** Window coords (`measureInWindow` / Modal root). Screen coords fail under a status-bar inset. */
export interface MenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `checked` is the group's current answer; the row is never a switch. */
export interface MenuActionRow {
  key: string;
  label: string;
  icon?: string;
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** Keep the card up — repeated steps. A choice about the surface underneath dismisses. */
  staysOpen?: boolean;
  onSelect: () => void;
}

export interface MenuSubmenuRow {
  key: string;
  label: string;
  icon?: string;
  rows: readonly MenuActionRow[];
}

export type MenuRow = MenuActionRow | MenuSubmenuRow;

export interface MenuGroup {
  key: string;
  rows: readonly MenuRow[];
}

export interface AnchoredMenuProps {
  visible: boolean;
  /** Unmeasured → top trailing corner, never refuse to open. */
  anchor: MenuAnchor | undefined;
  groups: readonly MenuGroup[];
  onClose: () => void;
}

const CARD_WIDTH = 280;
const ANCHOR_GAP = 6;
/** Floor: below this the scroll region has no room to scroll in. */
const MIN_CARD_HEIGHT = 132;
/** Reserved on every row so labels do not dance as the checkmark moves. */
const CHECK_SLOT = 22;

interface CardPlacement {
  insetInlineStart: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Flip on space each side actually has, never a guessed card height.
 * Trailing-aligned, then clamped into the 12pt inset.
 */
function cardPlacement(
  anchor: MenuAnchor | undefined,
  screen: { width: number; height: number }
): CardPlacement {
  const maxStart = Math.max(BAND_INSET, screen.width - CARD_WIDTH - BAND_INSET);
  if (!anchor) {
    return {
      insetInlineStart: maxStart,
      maxHeight: Math.max(screen.height - 2 * BAND_INSET, MIN_CARD_HEIGHT),
      top: BAND_INSET,
    };
  }
  const start = Math.min(
    Math.max(anchor.x + anchor.width - CARD_WIDTH, BAND_INSET),
    maxStart
  );
  const roomBelow =
    screen.height - (anchor.y + anchor.height) - ANCHOR_GAP - BAND_INSET;
  const roomAbove = anchor.y - ANCHOR_GAP - BAND_INSET;
  if (roomBelow >= roomAbove) {
    return {
      insetInlineStart: start,
      maxHeight: Math.max(roomBelow, MIN_CARD_HEIGHT),
      top: anchor.y + anchor.height + ANCHOR_GAP,
    };
  }
  return {
    bottom: screen.height - anchor.y + ANCHOR_GAP,
    insetInlineStart: start,
    maxHeight: Math.max(roomAbove, MIN_CARD_HEIGHT),
  };
}

function isSubmenu(row: MenuRow): row is MenuSubmenuRow {
  return Array.isArray((row as MenuSubmenuRow).rows);
}

/**
 * Never `onLayout` (parent-relative — the card would land at the top of the
 * screen). `measureInWindow` is the modal root; call on press, never cache.
 */
export function useMenuAnchor(): {
  anchorRef: React.RefObject<RNView | null>;
  anchor: MenuAnchor | undefined;
  measureAnchor: () => void;
} {
  const anchorRef = useRef<RNView | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | undefined>(undefined);
  const measureAnchor = useCallback(() => {
    const node = anchorRef.current;
    // Unlaid-out / non-native hosts have no measure — open unanchored, never throw.
    if (!node || typeof node.measureInWindow !== "function") return;
    node.measureInWindow((x, y, width, height) => {
      setAnchor({ height, width, x, y });
    });
  }, []);
  return { anchor, anchorRef, measureAnchor };
}

type MenuStyles = ReturnType<typeof makeStyles>;

function ActionRowView({
  row,
  colors,
  styles,
  onChoose,
}: {
  row: MenuActionRow;
  colors: ThemeColors;
  styles: MenuStyles;
  onChoose: (row: MenuActionRow) => void;
}): React.JSX.Element {
  const disabled = row.disabled === true;
  const ink = disabled
    ? colors.textDisabled
    : row.destructive === true
      ? colors.danger
      : colors.text;
  return (
    <Pressable
      accessibilityRole="menuitem"
      // `selected` alone is announced inconsistently across the two platforms.
      accessibilityLabel={
        row.checked === true ? `${row.label}. Selected` : row.label
      }
      accessibilityState={{ disabled, selected: row.checked === true }}
      disabled={disabled}
      onPress={() => onChoose(row)}
      style={styles.row}
    >
      <View style={styles.slot}>
        {row.checked === true ? (
          <Icon name="check" size={16} color={ink} />
        ) : null}
      </View>
      {row.icon ? <Icon name={row.icon} size={16} color={ink} /> : null}
      <Text
        style={[
          styles.label,
          // Leaf takes the state's token; never a container opacity (§18).
          disabled ? styles.labelDisabled : undefined,
          !disabled && row.destructive === true
            ? styles.labelDestructive
            : undefined,
        ]}
        numberOfLines={1}
      >
        {row.label}
      </Text>
    </Pressable>
  );
}

function SubmenuRowView({
  row,
  colors,
  styles,
  onOpen,
}: {
  row: MenuSubmenuRow;
  colors: ThemeColors;
  styles: MenuStyles;
  onOpen: (key: string) => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={`${row.label}. Opens a submenu`}
      onPress={() => onOpen(row.key)}
      style={styles.row}
    >
      <View style={styles.slot} />
      {row.icon ? <Icon name={row.icon} size={16} color={colors.text} /> : null}
      <Text style={styles.label} numberOfLines={1}>
        {row.label}
      </Text>
      <Icon name="chevron-right" size={16} color={colors.textFaint} />
    </Pressable>
  );
}

function MenuBody({
  groups,
  colors,
  styles,
  onClose,
}: {
  groups: readonly MenuGroup[];
  colors: ThemeColors;
  styles: MenuStyles;
  onClose: () => void;
}): React.JSX.Element {
  const [openKey, setOpenKey] = useState<string | undefined>(undefined);
  const submenu = useMemo(() => {
    if (openKey === undefined) return undefined;
    for (const group of groups) {
      for (const row of group.rows)
        if (isSubmenu(row) && row.key === openKey) return row;
    }
    return undefined;
  }, [groups, openKey]);

  const choose = useCallback(
    (row: MenuActionRow) => {
      row.onSelect();
      if (row.staysOpen !== true) onClose();
    },
    [onClose]
  );
  const back = useCallback(() => setOpenKey(undefined), []);

  if (submenu) {
    return (
      <>
        {/* A row, not a title-bar chevron: names the group it returns to. */}
        <Pressable
          accessibilityRole="menuitem"
          accessibilityLabel={`Back to ${submenu.label}`}
          onPress={back}
          style={[styles.row, styles.back]}
        >
          <View style={styles.slot}>
            <Icon name="chevron-left" size={16} color={colors.textFaint} />
          </View>
          <Text style={styles.label} numberOfLines={1}>
            {submenu.label}
          </Text>
        </Pressable>
        {submenu.rows.map((row) => (
          <ActionRowView
            key={row.key}
            row={row}
            colors={colors}
            styles={styles}
            onChoose={choose}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {groups.map((group, index) => (
        <View
          key={group.key}
          style={[styles.group, index > 0 ? styles.groupSeparated : undefined]}
        >
          {group.rows.map((row) =>
            isSubmenu(row) ? (
              <SubmenuRowView
                key={row.key}
                row={row}
                colors={colors}
                styles={styles}
                onOpen={setOpenKey}
              />
            ) : (
              <ActionRowView
                key={row.key}
                row={row}
                colors={colors}
                styles={styles}
                onChoose={choose}
              />
            )
          )}
        </View>
      ))}
    </>
  );
}

export default function AnchoredMenu({
  visible,
  anchor,
  groups,
  onClose,
}: AnchoredMenuProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const screen = useWindowDimensions();
  // Unmount on close so MenuBody's submenu path is plain state, never stale.
  if (!visible) return null;
  const placement = cardPlacement(anchor, screen);
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      {/* No scrim: dimming claims a sheet's weight; the card is already opaque. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close menu"
        onPress={onClose}
        style={styles.backdrop}
      />
      <View
        accessibilityViewIsModal
        accessibilityRole="menu"
        style={[styles.card, placement]}
      >
        <ScrollView>
          <MenuBody
            groups={groups}
            colors={colors}
            styles={styles}
            onClose={onClose}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    back: {
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
    },
    backdrop: { ...StyleSheet.absoluteFill },
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: BAND_RADIUS,
      borderWidth: borders.hairline,
      overflow: "hidden",
      position: "absolute",
      width: CARD_WIDTH,
    },
    group: {},
    groupSeparated: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    label: { ...t("small"), color: colors.text, flex: 1 },
    labelDestructive: { color: colors.danger },
    labelDisabled: { color: colors.textDisabled },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    slot: { alignItems: "center", width: CHECK_SLOT },
  });
