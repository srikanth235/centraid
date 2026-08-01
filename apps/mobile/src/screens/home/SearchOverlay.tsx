// The universal-search overlay (issue #498, Slice B change #6). Dock Search
// raises this as a full-screen frosted sheet — local component state, not a nav
// route, so it's cheap to open and dismiss. It autofocuses an input, filters the
// eight-app grid live, and hints that deeper search (photos, docs, people)
// arrives with the gateway.
//
// Tapping the scrim dismisses: the blurred background sits under a full-screen
// Pressable, and the content layer is `box-none`, so a tap on empty space falls
// through to close while taps on the input / a tile / Cancel are handled.

import { BlurView } from "expo-blur";
import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { family, t, useTheme } from "../../kit/theme";
import type { ThemeColors, Scheme } from "../../kit/theme";
import { BLUEPRINT_SEARCH_TARGETS, searchBlueprints } from "./blueprint-search";
import type { BlueprintSearchHit } from "./blueprint-search";
import { filterLauncherItems } from "./catalog";
import type { LauncherItem } from "./catalog";
import LauncherGrid from "./LauncherGrid";

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

  const matches = useMemo(
    () => filterLauncherItems(items, query),
    [items, query]
  );
  const trimmed = query.trim();
  const searchKey = `${appFilter ?? "all"}:${trimmed}`;
  const entityHits = entitySearch?.key === searchKey ? entitySearch.hits : [];
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
          ) : null}
          {trimmed ? (
            <View style={styles.entityResults}>
              <Text style={styles.sectionLabel}>RESULTS IN YOUR VAULT</Text>
              {entityHits.map((hit) => (
                <Pressable
                  key={`${hit.appId}:${hit.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${hit.label} in ${hit.appLabel}`}
                  onPress={() => openHit(hit)}
                  style={[styles.entityRow, { borderBottomColor: colors.line }]}
                >
                  <Icon
                    name="Search"
                    size={16}
                    color={colors.accent}
                    strokeWidth={1.8}
                  />
                  <View style={styles.entityCopy}>
                    <Text numberOfLines={1} style={styles.entityLabel}>
                      {hit.label}
                    </Text>
                    <Text numberOfLines={1} style={styles.entityDetail}>
                      {hit.appLabel}
                      {hit.detail ? ` · ${hit.detail}` : ""}
                    </Text>
                  </View>
                </Pressable>
              ))}
              {searching ? (
                <Text style={styles.empty}>Searching your vault…</Text>
              ) : entityHits.length === 0 ? (
                <Text style={styles.empty}>No vault results.</Text>
              ) : null}
            </View>
          ) : null}
          {matches.length ? (
            <LauncherGrid items={matches} onOpen={onOpen} />
          ) : (
            <Text style={styles.empty}>
              No apps match &ldquo;{trimmed}&rdquo;.
            </Text>
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
              enrichment setting is enabled.
            </Text>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    cancel: {
      ...t("body"),
      color: colors.accent,
      fontFamily: family.sansMedium,
    },
    content: { flex: 1, paddingHorizontal: H_PADDING },
    empty: { ...t("small"), color: colors.textSoft, paddingVertical: 8 },
    entityCopy: { flex: 1 },
    entityDetail: {
      ...t("small"),
      color: colors.textSoft,
      marginTop: 2,
    },
    entityLabel: { ...t("body"), color: colors.text },
    entityResults: { marginBottom: 22, marginTop: 18 },
    entityRow: {
      alignItems: "center",
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      minHeight: 58,
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
    results: { paddingTop: 22 },
    filters: { gap: 7, paddingVertical: 10 },
    filter: {
      backgroundColor: colors.bgElev,
      borderRadius: 999,
      minHeight: 32,
      paddingHorizontal: 12,
      justifyContent: "center",
    },
    filterText: { ...t("small"), fontFamily: family.sansMedium },
    sectionLabel: {
      ...t("small"),
      color: colors.textFaint,
      letterSpacing: 0.8,
      marginBottom: 3,
    },
    searchRow: { alignItems: "center", flexDirection: "row", gap: 12 },
  });
