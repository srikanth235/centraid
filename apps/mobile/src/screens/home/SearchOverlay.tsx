// The full-screen search overlay (issue #498, Slice B change #6; issue #707
// Phase 5 — "Search everything" from Home's header; issue #708 mobile
// close-out — objects, not apps). Local component state, not a nav route, so
// it's cheap to open and dismiss. It autofocuses an input and searches vault
// OBJECTS across every native app's replica — a note, a doc, a person, an
// event, a task, a tally entry, a photo. Results group by the app that owns
// them (icon + identity hue as the group marker); the app-name filter row
// and the launcher-icon matches below stay as a secondary "find the app
// itself" affordance, never the primary result.
//
// Tapping the scrim dismisses: the blurred background sits under a full-screen
// Pressable, and the content layer is `box-none`, so a tap on empty space falls
// through to close while taps on the input / a tile / Cancel are handled.

import { BlurView } from "expo-blur";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import AppIcon from "../../kit/components/AppIcon";
import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { family, metrics, t, useTheme } from "../../kit/theme";
import type { ThemeColors, Scheme } from "../../kit/theme";
import { BLUEPRINT_SEARCH_TARGETS, searchBlueprints } from "./blueprint-search";
import type { BlueprintSearchHit } from "./blueprint-search";
import { filterLauncherItems } from "./catalog";
import type { LauncherItem } from "./catalog";
import LauncherIconGrid from "./LauncherIconGrid";
import { formatSearchMeta, groupSearchHits } from "./search-model";
import type { RecentSourceRow, SearchGroup } from "./search-model";
import { useSearchRecents } from "./useSearchRecents";

const H_PADDING = 20;

// Full-screen live blur plus a translucent scheme film. expo-blur is a native
// dependency of the shipped app (also used by GlassBar), so this surface
// exercises the same compiled material instead of carrying a stale fallback.
const TINT: Record<Scheme, string> = {
  light: "rgba(241, 236, 225, 0.82)",
  dark: "rgba(16, 19, 24, 0.86)",
};

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
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { session } = useReplica();
  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState<string>();
  const [entitySearch, setEntitySearch] = useState<{
    key: string;
    hits: BlueprintSearchHit[];
    searching: boolean;
  }>();
  const { recents, suggestions } = useSearchRecents();

  const matches = useMemo(
    () => filterLauncherItems(items, query),
    [items, query]
  );
  const trimmed = query.trim();
  const searchKey = `${appFilter ?? "all"}:${trimmed}`;
  const entityHits = entitySearch?.key === searchKey ? entitySearch.hits : [];
  const groups = useMemo(() => groupSearchHits(entityHits), [entityHits]);
  const searching =
    Boolean(session && trimmed) &&
    (entitySearch?.key !== searchKey || entitySearch.searching);
  useEffect(() => {
    if (!session || !trimmed) return;
    let active = true;
    const timeout = setTimeout(() => {
      setEntitySearch({ key: searchKey, hits: [], searching: true });
      void searchBlueprints(session, trimmed, appFilter)
        .then((hits) => {
          if (active)
            setEntitySearch({ key: searchKey, hits, searching: false });
        })
        .finally(() => {
          if (active)
            setEntitySearch((current) =>
              current?.key === searchKey
                ? { ...current, searching: false }
                : current
            );
        });
    }, 160);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [appFilter, searchKey, session, trimmed]);
  const openHit = (hit: BlueprintSearchHit): void => {
    const item = items.find(
      (candidate) =>
        candidate.meta.id === hit.appId ||
        (candidate.route.kind === "app" && candidate.route.appId === hit.appId)
    );
    if (item) onOpen(item);
  };
  const openRecent = (recent: RecentSourceRow): void => {
    const item = items.find(
      (candidate) =>
        candidate.meta.id === recent.appId ||
        (candidate.route.kind === "app" &&
          candidate.route.appId === recent.appId)
    );
    if (item) onOpen(item);
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <BlurView
        intensity={60}
        tint={scheme === "dark" ? "dark" : "light"}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: TINT[scheme] }]}
        pointerEvents="none"
      />
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close search"
      />

      <View
        style={[styles.content, { paddingTop: insets.top + 8 }]}
        pointerEvents="box-none"
      >
        <View style={styles.searchRow}>
          <View style={styles.field}>
            <Icon
              name="Search"
              size={17}
              color={colors.textFaint}
              strokeWidth={1.8}
            />
            <TextInput
              accessibilityLabel="Search every app"
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder="Search everything"
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityLabel="Cancel search"
          >
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.results}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {trimmed ? (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filters}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: appFilter === undefined }}
                  onPress={() => setAppFilter(undefined)}
                  style={[
                    styles.filter,
                    appFilter ? undefined : { backgroundColor: colors.accent },
                  ]}
                >
                  <Text
                    style={[
                      styles.filterText,
                      { color: appFilter ? colors.textSoft : colors.bg },
                    ]}
                  >
                    All
                  </Text>
                </Pressable>
                {BLUEPRINT_SEARCH_TARGETS.map((target) => (
                  <Pressable
                    key={target.appId}
                    accessibilityRole="button"
                    accessibilityState={{
                      selected: appFilter === target.appId,
                    }}
                    onPress={() => setAppFilter(target.appId)}
                    style={[
                      styles.filter,
                      appFilter === target.appId && {
                        backgroundColor: colors.accent,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.filterText,
                        {
                          color:
                            appFilter === target.appId
                              ? colors.bg
                              : colors.textSoft,
                        },
                      ]}
                    >
                      {target.appLabel}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>

              <View style={styles.entityResults}>
                {groups.map((group) => (
                  <SearchResultGroup
                    key={group.appId}
                    group={group}
                    onPress={openHit}
                    styles={styles}
                    colors={colors}
                  />
                ))}
                {searching ? (
                  <Text style={styles.empty}>Searching your vault…</Text>
                ) : groups.length === 0 ? (
                  <Text style={styles.empty}>No vault results.</Text>
                ) : null}
              </View>

              {matches.length ? (
                <>
                  <Text style={styles.sectionLabel}>APPS</Text>
                  <LauncherIconGrid items={matches} onOpen={onOpen} />
                </>
              ) : null}
            </>
          ) : (
            <EmptyState
              recents={recents}
              suggestions={suggestions}
              onOpenRecent={openRecent}
              onSuggestion={setQuery}
              styles={styles}
              colors={colors}
            />
          )}

          <View style={styles.hint}>
            <Icon
              name="Sparkle"
              size={15}
              color={colors.textFaint}
              strokeWidth={1.7}
            />
            <Text style={styles.hintText}>
              Results come from the encrypted local FTS5 replica. Confirmed
              captions, OCR, people, and places appear only when their
              enrichment setting is enabled. Locker stays out of search — unlock
              it directly to find something there.
            </Text>
          </View>
        </ScrollView>
      </View>
    </View>
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
      <View style={styles.groupHeader}>
        <AppIcon
          name={group.appIconKey}
          color={group.appColor ?? colors.textFaint}
          size={22}
        />
        <Text
          style={[
            styles.groupLabel,
            { color: group.appColor ?? colors.textFaint },
          ]}
        >
          {group.appLabel}
        </Text>
      </View>
      {group.hits.map((hit) => (
        <ObjectRow
          key={`${hit.appId}:${hit.id}`}
          kind={hit.kind}
          label={hit.label}
          meta={formatSearchMeta(hit.meta)}
          accessibilityLabel={`Open ${hit.label} in ${hit.appLabel}`}
          onPress={() => onPress(hit)}
          styles={styles}
          colors={colors}
        />
      ))}
    </View>
  );
}

function EmptyState({
  recents,
  suggestions,
  onOpenRecent,
  onSuggestion,
  styles,
  colors,
}: {
  recents: readonly RecentSourceRow[];
  suggestions: readonly string[];
  onOpenRecent: (recent: RecentSourceRow) => void;
  onSuggestion: (label: string) => void;
  styles: Styles;
  colors: ThemeColors;
}): React.JSX.Element {
  if (recents.length === 0 && suggestions.length === 0) {
    return (
      <Text style={styles.empty}>
        Search fills in as your vault gathers notes, docs, people, and more.
      </Text>
    );
  }
  return (
    <View>
      {recents.length ? (
        <View style={styles.entityResults}>
          <Text style={styles.sectionLabel}>RECENTS</Text>
          {recents.map((recent) => (
            <View
              key={`${recent.appId}:${recent.id}`}
              style={[styles.entityRow, { borderBottomColor: colors.line }]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${recent.label} in ${recent.appLabel}`}
                onPress={() => onOpenRecent(recent)}
                style={styles.recentPress}
              >
                <AppIcon
                  name={recent.appIconKey}
                  color={recent.appColor ?? colors.textFaint}
                  size={20}
                />
                <RowText
                  kind={recent.kind}
                  label={recent.label}
                  meta={formatSearchMeta(recent.meta)}
                  styles={styles}
                />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {suggestions.length ? (
        <View style={styles.suggestions}>
          <Text style={styles.sectionLabel}>TRY SEARCHING FOR</Text>
          <View style={styles.chips}>
            {suggestions.map((label) => (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityLabel={`Search for ${label}`}
                onPress={() => onSuggestion(label)}
                style={[styles.filter, { backgroundColor: colors.bgElev }]}
              >
                <Text style={[styles.filterText, { color: colors.textSoft }]}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

// One vault-object row: kind in the mono register, title at the UI role,
// meta (date) in the numeric mono register — the three-register anatomy the
// Binding Layer's search contract specifies. `ObjectRow` wraps it in its own
// Pressable (grouped results, one app per group); `RowText` is the bare
// content, reused inside the recents row's own Pressable (which also needs
// to fit the app icon ahead of it).
function ObjectRow({
  kind,
  label,
  meta,
  accessibilityLabel,
  onPress,
  styles,
  colors,
}: {
  kind: string;
  label: string;
  meta: string | undefined;
  accessibilityLabel: string;
  onPress: () => void;
  styles: Styles;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={[styles.entityRow, { borderBottomColor: colors.line }]}
    >
      <RowText kind={kind} label={label} meta={meta} styles={styles} />
    </Pressable>
  );
}

function RowText({
  kind,
  label,
  meta,
  styles,
}: {
  kind: string;
  label: string;
  meta: string | undefined;
  styles: Styles;
}): React.JSX.Element {
  return (
    <>
      <Text style={styles.rowKind}>{kind}</Text>
      <Text numberOfLines={1} style={styles.entityLabel}>
        {label}
      </Text>
      {meta ? <Text style={styles.rowMeta}>{meta}</Text> : null}
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    cancel: {
      ...t("body"),
      color: colors.accent,
      fontFamily: family.sansMedium,
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
    content: { flex: 1, paddingHorizontal: H_PADDING },
    empty: { ...t("small"), color: colors.textSoft, paddingVertical: 8 },
    // Row anatomy is kind (mono) / title (UI role) / meta (numeric) — the
    // title is the UI role (13px/500, matching desktop's .rowLabel in
    // PaletteScreen.module.css), not reading-register body copy (#708).
    entityLabel: { ...t("control"), color: colors.text, flex: 1 },
    entityResults: { marginBottom: 22, marginTop: 4 },
    entityRow: {
      alignItems: "center",
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      // The row-height token, not a bespoke number — issue #707 Phase 5.
      minHeight: metrics.row,
    },
    field: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      flexDirection: "row",
      gap: 8,
      height: 46,
      paddingHorizontal: 12,
    },
    filters: { gap: 7, paddingVertical: 10 },
    filter: {
      backgroundColor: colors.bgElev,
      borderRadius: 999,
      minHeight: 32,
      paddingHorizontal: 12,
      justifyContent: "center",
    },
    filterText: { ...t("small"), fontFamily: family.sansMedium },
    group: { marginBottom: 16 },
    groupHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      marginBottom: 6,
    },
    // UI role, matching entityLabel's register fix above (#708).
    groupLabel: { ...t("control") },
    hint: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      marginTop: 28,
      paddingRight: 12,
    },
    hintText: {
      ...t("small"),
      color: colors.textFaint,
      flex: 1,
      lineHeight: 18,
    },
    input: { ...t("body"), color: colors.text, flex: 1, padding: 0 },
    recentPress: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: 10,
    },
    results: { paddingTop: 22 },
    rowKind: {
      ...t("mono"),
      color: colors.textFaint,
      width: 52,
    },
    rowMeta: {
      ...t("mono"),
      color: colors.textFaint,
      marginLeft: 8,
    },
    sectionLabel: {
      ...t("small"),
      color: colors.textFaint,
      letterSpacing: 0.8,
      marginBottom: 8,
    },
    searchRow: { alignItems: "center", flexDirection: "row", gap: 12 },
    suggestions: { marginBottom: 22 },
  });
