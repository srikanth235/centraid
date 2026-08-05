// The full-screen search overlay (issue #498, Slice B change #6; issue #707
// Phase 5 — "Search everything" from Home's header; issue #711 — rewritten to
// match the v4 Binding Layer handoff's search anatomy exactly:
// design_handoff_photos/"Centraid System - Binding Layer v4.dc.html" :3250–
// 3331 (markup) and :5996–6023 (styles). Local component state, not a nav
// route, so it's cheap to open and dismiss. It autofocuses an input and
// searches vault OBJECTS across every native app's replica — a note, a doc,
// a person, an event, a task, a tally entry, a photo. Results group by the
// app that owns them: a dot in the app's identity hue plus a micro-caps app
// name, never an app-filter chip row or an app-icon grid — the brief's
// "objects, not apps" contract holds in the anatomy here, not just the copy.
//
// Tapping the scrim dismisses: the opaque paper background sits under a
// full-screen Pressable, and the content layer is `box-none`, so a tap on
// empty space falls through to close while taps on the input / a chip / a
// result / Cancel are handled.

import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { nativeButtonStyle } from "@centraid/design";

import { Text, TextInput } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { ThemeValue } from "../../kit/theme/resolve";
import { searchBlueprints } from "./blueprint-search";
import type { BlueprintSearchHit } from "./blueprint-search";
import type { LauncherItem } from "./catalog";
import { groupSearchHits } from "./search-model";
import type { SearchGroup } from "./search-model";
import { useSearchRecents } from "./useSearchRecents";

// The brief's `R.margin.m` (:3356) — the mobile content margin every Home
// surface shares. Was 20 here (issue #711 audit item d), then the literal 18;
// it is now the shared `pageMargin` token, so no screen can drift again.
const H_PADDING = pageMargin;

// A stable-identity empty array — `hits` falls back to this rather than a
// fresh `[]` literal every render, so the `groups` useMemo below actually
// memoizes instead of recomputing on every keystroke that doesn't change it.
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
  const { colors, radii, targetMin } = useTheme();
  const styles = useMemo(
    () => makeStyles(colors, radii, targetMin),
    [colors, radii, targetMin]
  );
  const insets = useSafeAreaInsets();
  const { session } = useReplica();
  const [query, setQuery] = useState("");
  const [entitySearch, setEntitySearch] = useState<{
    key: string;
    hits: BlueprintSearchHit[];
    searching: boolean;
  }>();
  const { suggestions } = useSearchRecents();

  const trimmed = query.trim();
  // The brief's `searchIsRecent` (:6023) — the try-chip row is an empty-query
  // affordance only; it disappears the moment there is a real query to judge
  // results against.
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
    const item = items.find(
      (candidate) =>
        candidate.meta.id === hit.appId ||
        (candidate.route.kind === "app" && candidate.route.appId === hit.appId)
    );
    if (item) onOpen(item);
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* The brief's `searchPanelStyle` (:6000) is an OPAQUE paper surface
          (`t.surf` / bg-elev), not glass — no BlurView, no translucent tint
          film (issue #711 audit item c). On mobile the panel is full-bleed
          (:6000's `mob?'100%'`), so this one solid layer IS the panel. */}
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.bgElev }]}
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
        <View style={styles.headerRow}>
          <TextInput
            accessibilityLabel="Search every app"
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search everything in this vault"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {/* The brief's static scope label (:3260) — there is no app-filter
              chip row to narrow this against; search always spans every
              app, so the overlay says so rather than implying a choice. */}
          <Text style={styles.scope}>all apps</Text>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Cancel search"
            style={styles.cancel}
          >
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
        </View>

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
            // The brief's exact `searchEmptyCopy` (:6018), smart quotes and
            // all — never rewritten to straight quotes or paraphrased.
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

        {/* The brief's fixed foot (:3324–3329) — a count on the leading edge,
            the record-addressing caveat pinned to the trailing edge via
            `margin-inline-start: auto` (:3326). Always present, not gated on
            a query: an honest zero read ("0 across 0 apps") beats hiding the
            foot on an empty query. The brief's note copy (:6022, no `mob?`
            branch) starts with ↵ — a KEYBOARD glyph; a phone has no return
            key over results, so only the glyph becomes its tap equivalent.
            The honesty clause is verbatim. The note is its own trailing
            column (flex + right-aligned), so it wraps inside that column
            instead of running off the screen edge or under the count. */}
        <View style={styles.foot}>
          <Text style={styles.footText}>
            {hits.length} across {groups.length} app
            {groups.length === 1 ? "" : "s"}
          </Text>
          <Text style={[styles.footText, styles.footNote]}>
            tapping opens the owning app — record addressing is not built
          </Text>
        </View>
      </View>
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

// One result group: the brief's dot-in-fill-colour + micro-caps app name +
// mono count header (:3304–3309, :5273–5278), then its object rows.
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
            // Absent when the id is not in the design registry — the
            // renderer supplies a neutral token rather than inventing a hue.
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

// One vault-object row: kind (mono, a fixed column) / title (13px UI role) —
// the brief's row anatomy (:3315–3319, :5279–5286). `meta` exists on the hit
// but is dropped on purpose: the brief hides it on mobile (`mob?';display:
// none':''`, :5286), so this native row never renders a meta column at all.
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

const makeStyles = (
  colors: ThemeColors,
  radii: ThemeValue["radii"],
  targetMin: ThemeValue["targetMin"]
) => {
  // The brief's Cancel is an outlined secondary button pinned to 30px tall
  // (`btnSecondaryStyle+'height:30px;padding:0 12px;font-size:13px'`, :6008)
  // — the shared `Button` component's minHeight is the 48pt coarse tap
  // target every ordinary control uses, which is taller than the search
  // field row itself, so this reads the same recipe colours through
  // `nativeButtonStyle` and applies the compact geometry the brief specifies
  // for this one inline context, rather than routing through `Button`.
  const secondary = nativeButtonStyle("secondary", {
    colors,
    radii,
    targetMin,
  });
  return StyleSheet.create({
    cancel: {
      alignItems: "center",
      backgroundColor: secondary.backgroundColor,
      borderColor: secondary.borderColor,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      flexShrink: 0,
      height: 30,
      justifyContent: "center",
      paddingHorizontal: 12,
    },
    cancelLabel: { ...t("small"), color: secondary.color, fontSize: 13 },
    chip: {
      backgroundColor: "transparent",
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    chipLabel: { ...t("small"), color: colors.textSoft, fontSize: 13 },
    content: { flex: 1, paddingHorizontal: H_PADDING },
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
    // The note owns the trailing column: `flex: 1` bounds it to the space
    // the count leaves over (the RN analogue of the brief's
    // `margin-inline-start: auto`, :3326), and right alignment keeps it
    // pinned to the trailing edge while it wraps inside its own column.
    footNote: { flex: 1, textAlign: "right" },
    footText: { ...t("mono"), color: colors.textFaint },
    group: { marginBottom: 16 },
    groupCount: { ...t("mono"), color: colors.textFaint },
    groupDot: {
      borderRadius: 3,
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
    // Micro-caps role — carries its own uppercase + tracking, so the label
    // is never hand-uppercased on top of it (issue #711 audit item a/b).
    groupName: { ...t("eyebrow"), color: colors.textSoft, flex: 1 },
    headerRow: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      flexShrink: 0,
      gap: 12,
      paddingBottom: 16,
      paddingTop: 8,
    },
    input: {
      ...t("body"),
      color: colors.text,
      flex: 1,
      padding: 0,
    },
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
    scope: { ...t("mono"), color: colors.textFaint, flexShrink: 0 },
    suggestLabel: { ...t("mono"), color: colors.textFaint, flexShrink: 0 },
    // The brief's `suggestRowStyle` (:6009) is a plain flex row — ONE line,
    // no wrap. The model (selectSuggestionChips) already caps count and total
    // characters to what fits; `overflow: hidden` is the belt-and-braces
    // clip, never a second ragged row.
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
