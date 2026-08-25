// The ANCHORED MENU — a floating card hanging off the control that opened it,
// never a sheet (#712): the control stays put and the surface underneath never
// moves. A bottom sheet answers a destination-weight question instead.
//
// IN THE KIT because the anatomy is the frame's: the plate the band draws
// (`kit/band-surface.ts`), the same 12pt inset. An app-local copy is the drift
// `bandSurfaceStyle` exists to make unrepresentable.
//
// OPAQUE, NEVER GLASS: label contrast, the checkmark and the disabled ink
// cannot depend on what the member photographed, and
// `prefers-reduced-transparency` would need the opaque plate anyway.
//
// ONE LEVEL OF NESTING, drawn IN THE SAME CARD with a leading ‹ row rather than
// iOS' second stacked card — same layer count for the member, no second
// rectangle to measure against the screen edges. It stops at one level for the
// reason iOS' does: a member cannot hold a path they cannot see.
//
// No shadow, no elevation: product surfaces separate by their edge (§G).

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

/** WINDOW coordinates — what `measureInWindow` reports and where a `Modal`'s
 *  root lives. Screen coordinates are wrong under a status-bar inset. */
export interface MenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `checked` states the current answer of the group; the row is never a
 *  switch. */
export interface MenuActionRow {
  key: string;
  label: string;
  /** Leading glyph, after the checkmark slot. */
  icon?: string;
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** Keep the card up after the tap — for rows a member steps repeatedly. A
   *  choice about what the surface underneath shows dismisses instead. */
  staysOpen?: boolean;
  onSelect: () => void;
}

/** Opens one level of rows in place. */
export interface MenuSubmenuRow {
  key: string;
  label: string;
  icon?: string;
  rows: readonly MenuActionRow[];
}

export type MenuRow = MenuActionRow | MenuSubmenuRow;

/** Separated from the next group by a hairline — the menu's only grouping
 *  device; a card has no room for a sheet's section headings. */
export interface MenuGroup {
  key: string;
  rows: readonly MenuRow[];
}

export interface AnchoredMenuProps {
  visible: boolean;
  /** `undefined` until measured — the card falls back to the top trailing
   *  corner rather than refusing to open. */
  anchor: MenuAnchor | undefined;
  groups: readonly MenuGroup[];
  onClose: () => void;
}

/** Wide enough for "View Options" plus its chevron, narrow enough to read as
 *  hanging off a chip rather than as a panel. */
const CARD_WIDTH = 280;
const ANCHOR_GAP = 6;
/** A floor however tight the anchor is against an edge: below it the scroll
 *  region has no room to scroll IN. */
const MIN_CARD_HEIGHT = 132;
/** Reserved on EVERY row, checked or not, so labels do not dance left by a
 *  glyph's width as the answer moves. */
const CHECK_SLOT = 22;

interface CardPlacement {
  insetInlineStart: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Flips on the space each side actually has, never on a guess at the card's
 * height — that depends on the consumer's rows and is unknown until layout.
 *
 * TRAILING-ALIGNED horizontally, because a header chip lives at the trailing
 * edge, then clamped into the stage's 12pt inset so a centred or leading anchor
 * still yields a card fully on screen.
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
 * NEVER `onLayout`: it reports a position relative to the PARENT, not the space
 * a `Modal` draws in, so a chip's y lands the card at the top of the screen.
 * `measureInWindow` answers in the modal root's own coordinates, and being
 * imperative it is called on the press rather than cached into staleness.
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
    // Guarded: a host that has not laid out — or any non-native renderer — has
    // no measure method, and the menu must open unanchored rather than throw.
    if (!node || typeof node.measureInWindow !== "function") return;
    node.measureInWindow((x, y, width, height) => {
      setAnchor({ height, width, x, y });
    });
  }, []);
  return { anchor, anchorRef, measureAnchor };
}

/** Derived from the sheet, so a renamed key is a type error rather than a
 *  silently missing style. */
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
      // The label carries the answer too: `selected` alone is announced
      // inconsistently across the two platforms' menu roles.
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
          // The leaf takes the state's token; never a container opacity (§18).
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
  // Mounted only while the card is up, so the path resets on close without an
  // effect writing state off its own prop.
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
        {/* A ROW, not a title-bar chevron: first under the thumb that arrived
            here, and it names the group it returns to. */}
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

/** A transparent `Modal`, never an absolutely positioned View: the card must
 *  float over the header, the band and everything between, which no sibling of
 *  the header can do. */
export default function AnchoredMenu({
  visible,
  anchor,
  groups,
  onClose,
}: AnchoredMenuProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const screen = useWindowDimensions();
  // Unmounting on close is what lets `MenuBody` keep its submenu path in plain
  // state: no component holds a stale path to reset.
  if (!visible) return null;
  const placement = cardPlacement(anchor, screen);
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      {/* Transparent, never a scrim: dimming would claim a sheet's weight, and
          the card is opaque so legibility never depended on one. */}
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
    // The menu's ONLY grouping device: the boundary IS the rule.
    groupSeparated: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    label: { ...t("small"), color: colors.text, flex: 1 },
    labelDestructive: { color: colors.danger },
    labelDisabled: { color: colors.textDisabled },
    // 44pt, the frame's minimum target: a menu row is a control, not a line.
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    slot: { alignItems: "center", width: CHECK_SLOT },
  });
