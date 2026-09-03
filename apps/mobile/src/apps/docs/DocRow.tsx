// The document row (handoff Part 2 §"The document row"; #821).
//
// One row recipe, one STATE SLOT, and at most one thing in it — the
// precedence is fixed and lives in `docs-projection.ts` → the shared
// `rowStateMark` ladder, never inline here where three of its rungs could be
// true at once. On mobile the Kind, Size and Changed COLUMNS do not render (a
// 390px canvas cannot carry five columns and a title); those three facts ride
// a stacked sub-line instead (`docRowMeta` carries why a column's absence is
// not the fact's absence). What the row draws: the kind icon, the title, the
// meta line — led by the state slot's text rung — plus a matched passage under
// search, the device mark, the star, and the 44×44 `···`.
//
// Press-and-hold opens the same quick-actions menu the `···` opens — the
// mobile affordance the All shelf's status line names.
import React, { useMemo, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { View as RNView } from "react-native";

import {
  pendingChangeLabel,
  readPendingOverlay,
} from "@centraid/blueprints/apps/_shared/pending-overlay";

import type { MenuAnchor } from "../../kit/components/AnchoredMenu";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { TEST_IDS } from "../../kit/test-ids";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { docRowMeta, docRowState, kindIconName } from "./docs-projection";
import type { MobileDriveDoc } from "./docs-projection";

export interface DocRowProps {
  doc: MobileDriveDoc;
  /** The replica's own verdict, passed down — never invented per row. */
  offline: boolean;
  reason?: string;
  first?: boolean;
  onOpen: (doc: MobileDriveDoc) => void;
  onMenu: (doc: MobileDriveDoc, anchor: MenuAnchor | undefined) => void;
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (doc: MobileDriveDoc) => void;
}

export default function DocRow({
  doc,
  offline,
  reason,
  first,
  onOpen,
  onMenu,
  selecting = false,
  selected = false,
  onToggleSelect,
}: DocRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const moreRef = useRef<RNView | null>(null);
  const mark = docRowState(doc, { offline });
  const meta = docRowMeta(doc, mark);
  const overlay = readPendingOverlay(doc.raw);
  const pending = overlay ? pendingChangeLabel(overlay) : "";

  const openMenu = (): void => {
    const node = moreRef.current;
    if (!node) {
      onMenu(doc, undefined);
      return;
    }
    node.measureInWindow((x, y, width, height) => {
      onMenu(doc, { x, y, width, height });
    });
  };

  return (
    <Pressable
      accessibilityRole={selecting ? "checkbox" : "button"}
      accessibilityLabel={doc.title}
      {...(selecting ? { accessibilityState: { checked: selected } } : {})}
      onPress={() => (selecting ? onToggleSelect?.(doc) : onOpen(doc))}
      // Press-and-hold keeps its meaning inside a choice: it PICKS, because the
      // menu it would otherwise open is stood down here.
      onLongPress={() => (selecting ? onToggleSelect?.(doc) : openMenu())}
      testID={first ? TEST_IDS.docs.rowFirst : undefined}
      style={[styles.row, first ? undefined : styles.rowRule]}
    >
      {selecting ? (
        <View style={[styles.box, selected ? styles.boxOn : undefined]}>
          {selected ? (
            <Icon name="Check" size={12} color={colors.onAccent} />
          ) : null}
        </View>
      ) : (
        <Icon name={kindIconName(doc)} size={18} color={colors.textSoft} />
      )}
      <View style={styles.main}>
        <Text numberOfLines={1} style={styles.title}>
          {doc.title}
        </Text>
        {/* The reason OUTRANKS the facts — why this document is in this set
            beats how big it is. Never both at once: a third line would cost
            the row its 44. */}
        {reason ? (
          <Text numberOfLines={1} style={styles.reason}>
            {reason}
          </Text>
        ) : (
          <Text numberOfLines={1} style={styles.meta}>
            {meta.lead ? (
              <Text style={meta.leadNet ? { color: colors.net } : undefined}>
                {meta.lead}
              </Text>
            ) : null}
            {meta.lead ? " · " : ""}
            {meta.rest}
          </Text>
        )}
        {pending ? (
          <Text numberOfLines={1} style={styles.pending}>
            {pending}
          </Text>
        ) : null}
      </View>
      {mark?.kind === "glyph" ? (
        // The device mark — a glyph, never a sentence; the caption under the
        // set carries the prose, once (§4.1).
        <View accessibilityLabel={mark.text} accessible>
          <Icon name="Smartphone" size={14} color={colors.textSoft} />
        </View>
      ) : null}
      {doc.starred ? (
        <View accessibilityLabel="Starred" accessible>
          <Icon name="Star" size={14} color={colors.cTeal} />
        </View>
      ) : null}
      {selecting ? null : (
        <Pressable
          ref={moreRef}
          accessibilityRole="button"
          accessibilityLabel={`More for ${doc.title}`}
          onPress={openMenu}
          style={styles.more}
        >
          <Icon name="more-vertical" size={18} color={colors.textSoft} />
        </Pressable>
      )}
    </Pressable>
  );
}

/**
 * The grid's tile — the same set as a grid. "The preview is a title and a
 * kind, never a fabricated page image" (§1); the state slot survives the
 * arrangement because a fact about a document does not depend on how the set
 * is drawn.
 */
export function DocGridTile({
  doc,
  offline,
  onOpen,
  onMenu,
}: Pick<
  DocRowProps,
  "doc" | "offline" | "onOpen" | "onMenu"
>): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const mark = docRowState(doc, { offline });
  const meta = docRowMeta(doc, mark);
  // Where a queued write is, on the row it changed (#880) — its own line, as
  // the one state slot's ladder is a fact about the document.
  const overlay = readPendingOverlay(doc.raw);
  const pending = overlay ? pendingChangeLabel(overlay) : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={doc.title}
      onPress={() => onOpen(doc)}
      onLongPress={() => onMenu(doc, undefined)}
      style={styles.tile}
    >
      <View style={styles.tileHead}>
        <Icon name={kindIconName(doc)} size={18} color={colors.textSoft} />
        {doc.starred ? (
          <Icon name="Star" size={14} color={colors.cTeal} />
        ) : null}
      </View>
      <Text numberOfLines={2} style={styles.title}>
        {doc.title}
      </Text>
      <Text numberOfLines={1} style={styles.meta}>
        {meta.rest}
      </Text>
      {mark ? (
        <Text
          numberOfLines={1}
          style={[styles.state, mark.net ? { color: colors.net } : undefined]}
          accessibilityLabel={mark.text}
        >
          {mark.kind === "glyph" ? "on this device only" : mark.text}
        </Text>
      ) : null}
      {pending ? (
        <Text numberOfLines={1} style={styles.pending}>
          {pending}
        </Text>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    box: {
      alignItems: "center",
      borderColor: colors.lineStrong,
      borderRadius: radii.pill,
      borderWidth: borders.hairline,
      height: 18,
      justifyContent: "center",
      width: 18,
    },
    boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    main: { flex: 1, gap: 2, minWidth: 0 },
    more: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      minHeight: 44,
      paddingStart: 12,
      paddingVertical: spacing[2],
    },
    rowRule: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    meta: { ...t("small"), color: colors.textFaint },
    pending: { ...t("small"), color: colors.textFaint },
    reason: { ...t("small"), color: colors.textFaint },
    state: { ...t("small"), color: colors.textSoft, flexShrink: 1 },
    tile: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      flex: 1,
      gap: 4,
      margin: 6,
      minHeight: 104,
      padding: 12,
    },
    tileHead: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    title: { ...t("body"), color: colors.text },
  });
