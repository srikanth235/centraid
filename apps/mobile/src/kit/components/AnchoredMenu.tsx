// The ANCHORED MENU — the second layer iOS has and this app did not (#712).
//
// iOS Photos' header chips do not open sheets. They open a floating card
// hanging off the chip itself: the control stays where it is, the card appears
// beside it, and the surface underneath never moves. A bottom sheet answers a
// different question ("here is a destination-weight decision"), and answering
// a two-tap preference with it costs a member the whole screen and the sense
// of where the control they pressed went.
//
// WHY THIS LIVES IN THE KIT. The anatomy is the frame's, not any one app's:
// the same plate the band draws (`kit/band-surface.ts` — opaque `bgElev`
// ground, 1pt `lineStrong` edge, 12 radius), the same 12pt inset off the
// stage. An app-local copy would be the exact drift `bandSurfaceStyle` was
// extracted to make unrepresentable.
//
// OPAQUE, NEVER GLASS. iOS' own menu is a blur plate; this app's is paper.
// The argument is `PhotosBand.tsx`'s header, unchanged: a card that floats
// over unpredictable photographs cannot let label contrast, the checkmark and
// the disabled ink depend on what the member photographed, and
// `prefers-reduced-transparency` would need the opaque plate anyway — so glass
// would mean maintaining two menus.
//
// ONE LEVEL OF NESTING, AND A DELIBERATE SIMPLIFICATION. iOS expands a
// disclosure row into a SECOND card stacked over the first, the parent dimmed
// but still drawn. This draws the submenu IN THE SAME CARD, with a leading ‹
// row carrying the parent's label as the way back. It is the same layer count
// for the member (one card, one step in, one step back) and it costs no
// measurement of a second floating rectangle against the same screen edges —
// the stacked presentation is the part of iOS' menu that is decoration, and
// the "where am I / how do I get back" part is the part that is meaning. The
// nesting stops at one level for the same reason iOS' does: a member cannot
// hold a path they cannot see.
//
// The card never gets a shadow or an elevation. Every product surface in this
// tree is separated by its edge, not by a drop shadow (§G).

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

/** Where the anchoring control sits, in WINDOW coordinates — the space
 *  `measureInWindow` reports and the space a `Modal`'s own root lives in.
 *  Screen coordinates would be wrong under a status bar inset. */
export interface MenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A row that DOES something. `checked` drives the leading mark; the row is
 *  never a switch — the mark states the current answer of the group it sits
 *  in, exactly as iOS' menus do. */
export interface MenuActionRow {
  key: string;
  label: string;
  /** Optional leading glyph, after the checkmark slot. */
  icon?: string;
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /**
   * Keep the card up after the tap. iOS' zoom rows behave this way — a member
   * steps a density two or three rungs in a row and wants to SEE each one —
   * while a filter choice dismisses, because it is a decision about what the
   * surface underneath shows and holding the card over the answer hides it.
   */
  staysOpen?: boolean;
  onSelect: () => void;
}

/** A row that OPENS one level of rows in place. */
export interface MenuSubmenuRow {
  key: string;
  label: string;
  icon?: string;
  rows: readonly MenuActionRow[];
}

export type MenuRow = MenuActionRow | MenuSubmenuRow;

/** Rows that belong together, separated from the next group by a hairline —
 *  the menu's only grouping device, since a menu card has no room for the
 *  section headings a sheet can afford. */
export interface MenuGroup {
  key: string;
  rows: readonly MenuRow[];
}

export interface AnchoredMenuProps {
  visible: boolean;
  /** `undefined` until the consumer has measured its control — the card then
   *  falls back to the top trailing corner rather than refusing to open. */
  anchor: MenuAnchor | undefined;
  groups: readonly MenuGroup[];
  onClose: () => void;
}

/** iOS' own menu width, near enough: wide enough for "View Options" plus its
 *  chevron, narrow enough that it reads as hanging off a chip rather than as a
 *  panel. */
const CARD_WIDTH = 280;
/** The gap between the card and the control it hangs from. */
const ANCHOR_GAP = 6;
/** A card can never be shorter than this, however tight the anchor is against
 *  an edge — below it the scroll region has no room to scroll IN. */
const MIN_CARD_HEIGHT = 132;
/** The leading slot the checkmark occupies. Reserved on EVERY row, checked or
 *  not, so the labels of one group line up instead of dancing left by the
 *  width of a glyph as the answer moves. */
const CHECK_SLOT = 22;

interface CardPlacement {
  insetInlineStart: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Below the anchor when there is more room below, above it when there is more
 * room above — the flip iOS performs, decided on the space each side actually
 * has rather than on a fixed guess at the card's height (which depends on the
 * rows the consumer passed and is not known until layout).
 *
 * Horizontally the card is TRAILING-ALIGNED to the anchor: a header chip lives
 * at the trailing edge, and a card that hung leading-aligned from it would run
 * off the screen. It is then clamped into the stage's own 12pt inset, so a
 * centred or leading anchor still yields a card fully on screen.
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
 * Measure the control a menu hangs from.
 *
 * `onLayout` reports a position relative to the PARENT, which is not the space
 * a `Modal` draws in — a header chip's `onLayout` y is its offset inside the
 * header row, and a card placed at that y would land at the top of the screen.
 * `measureInWindow` is the one call that answers in the same coordinates the
 * modal root uses, and it is imperative, so the consumer measures on the press
 * that opens the menu rather than keeping a value that goes stale on rotation.
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
    // Guarded rather than assumed: a host component that has not laid out yet
    // — and any renderer that is not the native one — has no measure method,
    // and the menu opens unanchored instead of throwing on the press.
    if (!node || typeof node.measureInWindow !== "function") return;
    node.measureInWindow((x, y, width, height) => {
      setAnchor({ height, width, x, y });
    });
  }, []);
  return { anchor, anchorRef, measureAnchor };
}

/** The one style record every row component shares — derived from the sheet
 *  itself so a renamed key is a type error rather than a silently missing
 *  style. */
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
      // The label carries the answer too. A checkmark is a fact a screen
      // reader cannot see, and `selected` alone is announced inconsistently
      // across the two platforms' menu roles.
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
          // The leaf takes the state's own token; the row is never dimmed by a
          // container opacity (§18).
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
  // Mounted only while the card is up (see `AnchoredMenu` below), so the path
  // resets on close without an effect that writes state off its own prop.
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
        {/* The way back, as a ROW rather than a chevron in a title bar: it is
            the first thing under the thumb that arrived here, and it names the
            group it returns to instead of leaving "back to what?" implicit. */}
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

/**
 * The menu itself. A transparent `Modal` rather than an absolutely positioned
 * View, because the card has to float over the header it hangs from — and over
 * the band, and over anything an app puts between them — which no sibling of
 * the header can do.
 */
export default function AnchoredMenu({
  visible,
  anchor,
  groups,
  onClose,
}: AnchoredMenuProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const screen = useWindowDimensions();
  // Unmounting the whole card on close is what lets `MenuBody` keep its own
  // submenu path in plain state: there is no stale path to reset because
  // there is no component holding one.
  if (!visible) return null;
  const placement = cardPlacement(anchor, screen);
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      {/* Transparent, not a scrim. A menu is a lightweight aside from a
          control the member can still see; dimming the surface would claim the
          weight of the sheet this replaced. The card is opaque, so legibility
          never depended on the scrim. */}
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
    // A group is a plain stack; the SEPARATION below is the only mark.
    group: {},
    // The menu's ONLY grouping device — a menu card has no room for the
    // section headings a sheet can afford, so the boundary IS the rule.
    groupSeparated: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    label: { ...t("small"), color: colors.text, flex: 1 },
    labelDestructive: { color: colors.danger },
    labelDisabled: { color: colors.textDisabled },
    // 44pt, the frame's own minimum target — a menu row is a control, not a
    // list line, and the card is reached one-handed from a header chip.
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    slot: { alignItems: "center", width: CHECK_SLOT },
  });
