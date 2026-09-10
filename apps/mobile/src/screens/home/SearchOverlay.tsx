// Full-screen Home search (#498, #711). Objects, not apps. Scrim dismisses; content is `box-none`.

import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { PushedPage } from "../../kit/rooms";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { ThemeValue } from "../../kit/theme/resolve";
import { searchBlueprints } from "./blueprint-search";
import type { BlueprintSearchHit } from "./blueprint-search";
import type { LauncherItem } from "./catalog";
import { groupSearchHits } from "./search-model";
import type { SearchGroup } from "./search-model";
import { useSearchRecents } from "./useSearchRecents";

const EMPTY_HITS: readonly BlueprintSearchHit[] = [];

export interface SearchOverlayProps {
  items: readonly LauncherItem[];
  onOpen: (item: LauncherItem) => void;
  onClose: () => void;
}

export default function SearchOverlay({
  items,
  onOpen,
  onClose,
}: SearchOverlayProps): React.JSX.Element {
  const { colors, radii } = useTheme();
  const styles = useMemo(() => makeStyles(colors, radii), [colors, radii]);
  const { session } = useReplica();
  const [query, setQuery] = useState("");
  const [entitySearch, setEntitySearch] = useState<{
    key: string;
    hits: BlueprintSearchHit[];
    searching: boolean;
  }>();
  const { suggestions } = useSearchRecents();

  const trimmed = query.trim();
  const isEmptyQuery = trimmed.length === 0;
  const hits = entitySearch?.key === trimmed ? entitySearch.hits : EMPTY_HITS;
  const groups = useMemo(() => groupSearchHits(hits), [hits]);
  const searching =
    Boolean(session && trimmed) &&
    (entitySearch?.key !== trimmed || entitySearch.searching);
  useEffect(() => {
    if (!session || !trimmed) return;
    let active = true;
    const timeout = setTimeout(() => {
      setEntitySearch({ key: trimmed, hits: [], searching: true });
      void searchBlueprints(session, trimmed)
        .then((found) => {
          if (active)
            setEntitySearch({ key: trimmed, hits: found, searching: false });
        })
        .finally(() => {
          if (active)
            setEntitySearch((current) =>
              current?.key === trimmed
                ? { ...current, searching: false }
                : current
            );
        });
    }, 160);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [session, trimmed]);
  const openHit = (hit: BlueprintSearchHit): void => {
    const item = items.find((candidate) => candidate.meta.id === hit.appId);
    if (item) onOpen(item);
  };

  return (
    <PushedPage
      onBack={onClose}
      search={{
        accessibilityLabel: "Search every app",
        // The page IS the search: the member opened it to type (#1015, R-B-7).
        autoFocus: true,
        count: `${hits.length} across ${groups.length} app${
          groups.length === 1 ? "" : "s"
        }`,
        onChangeText: setQuery,
        placeholder: "Search everything in this vault",
        value: query,
      }}
      secondary={{ label: "Cancel", onPress: onClose }}
      title="Search"
    >
      {isEmptyQuery && suggestions.length ? (
        <View style={styles.suggestRow}>
          <Text style={styles.suggestLabel}>try</Text>
          {suggestions.map((label) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={`Search for ${label}`}
              onPress={() => setQuery(label)}
              style={styles.chip}
            >
              <Text style={styles.chipLabel}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {searching ? (
          <Text style={styles.empty}>Searching your vault…</Text>
        ) : !isEmptyQuery && groups.length === 0 ? (
          <Text style={styles.empty}>
            {"Nothing across your apps matches “" + trimmed + "”."}
          </Text>
        ) : (
          groups.map((group) => (
            <SearchResultGroup
              key={group.appId}
              group={group}
              onPress={openHit}
              styles={styles}
              colors={colors}
            />
          ))
        )}
      </ScrollView>

      {/* The count rides on the field; this is the caveat under it. */}
      <View style={styles.foot}>
        <Text style={[styles.footText, styles.footNote]}>
          tapping opens the owning app — record addressing is not built
        </Text>
      </View>
    </PushedPage>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function SearchResultGroup({
  group,
  onPress,
  styles,
  colors,
}: {
  group: SearchGroup;
  onPress: (hit: BlueprintSearchHit) => void;
  styles: Styles;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <View style={styles.group}>
      <View style={styles.groupHead}>
        <View
          style={[
            styles.groupDot,
            { backgroundColor: group.appColor ?? colors.textFaint },
          ]}
        />
        <Text style={styles.groupName}>{group.appLabel}</Text>
        <Text style={styles.groupCount}>{group.hits.length}</Text>
      </View>
      {group.hits.map((hit) => (
        <ObjectRow
          key={`${hit.appId}:${hit.id}`}
          kind={hit.kind}
          label={hit.label}
          accessibilityLabel={`Open ${hit.label} in ${hit.appLabel}`}
          onPress={() => onPress(hit)}
          styles={styles}
        />
      ))}
    </View>
  );
}

function ObjectRow({
  kind,
  label,
  accessibilityLabel,
  onPress,
  styles,
}: {
  kind: string;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  styles: Styles;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={styles.row}
    >
      <Text style={styles.rowKind}>{kind}</Text>
      <Text numberOfLines={1} style={styles.rowTitle}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors, radii: ThemeValue["radii"]) => {
  return StyleSheet.create({
    chip: {
      backgroundColor: "transparent",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      paddingHorizontal: spacing[3],
      paddingVertical: 4,
    },
    chipLabel: {
      ...t("small"),
      color: colors.textSoft,
      fontSize: t("mono").fontSize,
    },
    empty: { ...t("small"), color: colors.textSoft, paddingVertical: 8 },
    foot: {
      alignItems: "flex-start",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      flexShrink: 0,
      gap: 12,
      paddingBottom: 8,
      paddingTop: 8,
    },
    footNote: { flex: 1, textAlign: "right" },
    footText: { ...t("mono"), color: colors.textFaint },
    group: { marginBottom: 16 },
    groupCount: { ...t("mono"), color: colors.textFaint },
    groupDot: {
      borderRadius: radii.sm,
      flexShrink: 0,
      height: 6,
      width: 6,
    },
    groupHead: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      paddingBottom: 4,
      paddingTop: 8,
    },
    groupName: { ...t("eyebrow"), color: colors.textSoft, flex: 1 },
    list: { flex: 1 },
    listContent: { paddingBottom: 24, paddingTop: 8 },
    row: {
      alignItems: "baseline",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: 12,
      paddingVertical: 8,
    },
    rowKind: {
      ...t("mono"),
      color: colors.textFaint,
      flexShrink: 0,
      width: 64,
    },
    rowTitle: { ...t("control"), color: colors.text, flex: 1 },
    suggestLabel: { ...t("mono"), color: colors.textFaint, flexShrink: 0 },
    suggestRow: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      flexShrink: 0,
      gap: 8,
      overflow: "hidden",
      paddingBottom: 12,
      paddingTop: 4,
    },
  });
};
