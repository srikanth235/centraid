// The document row (handoff Part 2 §"The document row"; #821).
//
// One row recipe, one STATE SLOT, and at most one thing in it — the
// precedence is fixed and lives in `docs-projection.ts` → the shared
// `rowStateMark` ladder, never inline here where three of its rungs could be
// true at once. On mobile the Kind, Size and Changed columns do not render
// (a 390px canvas cannot carry five columns and a title); what survives is
// the kind icon, the title (plus a matched passage under search), the state
// slot, the device mark, the star, and the 44×44 `···`.
//
// Press-and-hold opens the same quick-actions menu the `···` opens — the
// mobile affordance the All shelf's status line names.

import React, { useMemo, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { View as RNView } from "react-native";

import { typeMeta } from "@centraid/blueprints/apps/docs/format";

import type { MenuAnchor } from "../../kit/components/AnchoredMenu";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { docRowState, kindIconName } from "./docs-projection";
import type { MobileDriveDoc } from "./docs-projection";

export interface DocRowProps {
  doc: MobileDriveDoc;
  /** The replica's own verdict, passed down — never invented per row. */
  offline: boolean;
  /** The matched passage, on a search result row only. */
  snippet?: string;
  /** The first row of its container draws no top hairline. */
  first?: boolean;
  onOpen: (doc: MobileDriveDoc) => void;
  /** Both doors — the `···` and press-and-hold — open the same menu; the
   *  anchor is the `···`'s own frame so the card hangs off something real. */
  onMenu: (doc: MobileDriveDoc, anchor: MenuAnchor | undefined) => void;
}

export default function DocRow({
  doc,
  offline,
  snippet,
  first,
  onOpen,
  onMenu,
}: DocRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const moreRef = useRef<RNView | null>(null);
  const mark = docRowState(doc, { offline });

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
      accessibilityRole="button"
      accessibilityLabel={doc.title}
      onPress={() => onOpen(doc)}
      onLongPress={openMenu}
      style={[styles.row, first ? undefined : styles.rowRule]}
    >
      <Icon name={kindIconName(doc)} size={18} color={colors.textSoft} />
      <View style={styles.main}>
        <Text numberOfLines={1} style={styles.title}>
          {doc.title}
        </Text>
        {snippet ? (
          <Text numberOfLines={1} style={styles.snippet}>
            {snippet}
          </Text>
        ) : null}
      </View>
      {mark?.kind === "text" ? (
        <Text
          numberOfLines={1}
          style={[styles.state, mark.net ? { color: colors.net } : undefined]}
        >
          {mark.text}
        </Text>
      ) : null}
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
      <Pressable
        ref={moreRef}
        accessibilityRole="button"
        accessibilityLabel={`More for ${doc.title}`}
        onPress={openMenu}
        style={styles.more}
      >
        <Icon name="more-vertical" size={16} color={colors.textSoft} />
      </Pressable>
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
  const kind = typeMeta(doc.media_type, doc.title);
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
      <Text numberOfLines={1} style={styles.snippet}>
        {kind.name}
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
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
    },
    rowRule: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
    },
    snippet: { ...t("small"), color: colors.textFaint },
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
