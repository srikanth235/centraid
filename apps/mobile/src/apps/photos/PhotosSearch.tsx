// Search on the phone (Photos v4 handoff §9, §14, §18, proto:4256-4276).
//
// Search is a BAND DESTINATION, not a pushed screen. `PhotosHome` renders
// `PhotosSearchView` in place of the timeline exactly as it renders Albums and
// People, so the band stays up with Search current and the frame's Home capsule
// stays reachable — proto:4953-4954's `appBandOn` excludes only the viewer,
// zoom, video, slideshow and the editor, and Search is none of those. The
// pushed route this file used to be had a back chevron and no band, which broke
// that rule and made Search feel like leaving Photos.
//
// The surface itself is ONE query box (proto:4257) over the shelf's four
// states. There is no chip rail and there are no date fields: the handoff never
// had them, and the ones this file used to draw cycled blindly through every
// person / place / album row per tap, which is a control that cannot be aimed.
//
//   nothing typed  a panel naming what is searched, plus the five REAL example
//                  queries as mono chips that fill the field on tap
//   searching      a determinate line. Never a spinner (§18)
//   results        the grouped hits (`search-hits.ts`) above the justified grid
//   no results     the query quoted back — "no matches" without the term is a
//                  screen that could be about anything
//   unreachable    a fifth thing, deliberately not one of the four: search will
//                  not pretend to have looked
//
// The copy here is the web shell's copy verbatim wherever the handoff gives a
// string, so the two clients teach one fact. Where it does not — see
// `SEARCH_SCOPE` — the wording states what this code actually does.

import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { OnlineOnlyError } from "@centraid/client/replica/native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosScreenProps } from "../../navigation";
import PhotoTimeline from "./PhotoTimeline";
import { groupedSearchHits } from "./search-hits";
import type { SearchHit } from "./search-hits";
import { sectionPhotoAssets } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

/**
 * The five example queries the resting panel offers, verbatim from proto:4269.
 * The web shell offers the same five; examples that differ per surface would
 * teach a member that the surfaces search different things.
 */
const SEARCH_EXAMPLES: readonly string[] = [
  "ana at the coast",
  "videos from June",
  "Pemberton kitchen",
  "scans from the solicitor",
  "photographs with no place",
];

/**
 * What the foot line claims (proto:3961 says `128 results · searched the live
 * library`).
 *
 * Mobile does not search a live library. `session.search` resolves against the
 * REPLICA's own eager-metadata surface (`REPLICA_LOCAL_SEARCH` in
 * `packages/client/src/replica/search.ts` — `core.content_item.title`), and the
 * people, places and albums below come from replica rows too. The true claim is
 * therefore the half of proto:3960 that matters — the whole replica on this
 * device, not the window that happens to be scrolled into view — and that is
 * what this says. A foot line that claimed "the live library" would be a
 * sentence the code does not keep.
 */
const SEARCH_SCOPE = "searched the whole replica on this device";

const RESTING_EYEBROW = "Nothing typed";
const RESTING_TITLE = "Search the whole library";
const RESTING_BODY =
  "Not the photographs that happen to be loaded. Try one of these.";

const NONE_EYEBROW = "No results";
/**
 * proto:4271's body is `Nothing in captions, people, places, things or album
 * names. Two letters short of a place you have been.` Two words of it are not
 * available to this client and are therefore not said:
 *
 *   - "things" — the vault has no scene/label entity (see `search-hits.ts`),
 *     so nothing here looked at things and the sentence must not claim it did
 *   - the second sentence is a fact about the mock's particular query
 *     ("ana at the coas"), not about any query a member might type
 */
const NONE_BODY = "Nothing in captions, people, places or album names.";
const NONE_ACTION = "Clear the query";

const UNREACHABLE_EYEBROW = "Cannot reach the vault";
const UNREACHABLE_TITLE = "Search needs the gateway";
/** proto:4274, with the mock's gateway name generalised — this client does not
 *  know it is talking to `home-gateway`. */
const UNREACHABLE_BODY =
  "The index lives on the gateway, which is unreachable. The timeline still browses from this device; search does not, and will not pretend to have looked.";
const UNREACHABLE_FACTS: readonly (readonly [string, string])[] = [
  ["what still works", "browsing, albums, favorites, captions"],
  ["what does not", "search, people, places"],
];

type Nav = PhotosScreenProps<"PhotosHome">["navigation"];

/**
 * The route this file used to be is still registered (`App.tsx`) so nothing in
 * the navigator dangles, but the band now renders the view in place and no
 * caller pushes it. It is dead registration awaiting removal by whoever owns
 * the navigator.
 */
export default function PhotosSearch({
  navigation,
}: PhotosScreenProps<"PhotosSearch">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.toneMat }]}
      edges={["top"]}
    >
      <PhotosSearchView navigation={navigation as unknown as Nav} />
    </SafeAreaView>
  );
}

export function PhotosSearchView({
  navigation,
}: {
  navigation: Nav;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { session } = useReplica();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const { assets } = usePhotoTimeline();
  const [term, setTerm] = useState("");
  const [contentIds, setContentIds] = useState<Set<string>>();
  const [searching, setSearching] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  // Bumped by Retry. The query effect depends on it, so pressing Retry re-runs
  // the SAME query rather than sending the member somewhere else — the old
  // "Search online" control navigated to AppDetail, which is not a retry and
  // not a search.
  const [attempt, setAttempt] = useState(0);

  const collections = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection" }), [])
  );
  const entries = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection_entry" }), [])
  );
  const faces = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_region" }), [])
  );
  const parties = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.party" }), [])
  );
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.place" }), [])
  );
  const contentItems = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.content_item" }), [])
  );

  // The searching state starts the moment the term does — set in the event
  // handler, not in the effect, so the effect never writes state synchronously
  // during a render commit. The 180ms settle below is part of the wait.
  const onTerm = (text: string): void => {
    setTerm(text);
    if (text.trim() && session) setSearching(true);
  };

  useEffect(() => {
    let cancelled = false;
    const trimmed = term.trim();
    const timeout = setTimeout(() => {
      if (!trimmed || !session) {
        setContentIds(undefined);
        setUnreachable(false);
        setSearching(false);
        return;
      }
      void session
        .search("photos", {
          entity: "core.content_item",
          query: trimmed,
          limit: 300,
        })
        .then((result) => {
          if (cancelled) return;
          setContentIds(
            new Set(result.rows.map((row) => String(row.values.content_id)))
          );
          setUnreachable(false);
          setSearching(false);
        })
        .catch((error) => {
          if (cancelled) return;
          setContentIds(new Set());
          setSearching(false);
          setUnreachable(error instanceof OnlineOnlyError);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [attempt, session, term]);

  const matches = useMemo(
    () =>
      contentIds
        ? assets.filter(
            (asset) => asset.contentId && contentIds.has(asset.contentId)
          )
        : [],
    [assets, contentIds]
  );
  const sections = useMemo(() => sectionPhotoAssets(matches), [matches]);

  const contentTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const row of contentItems.rows) {
      const id = row.content_id;
      const title = row.title;
      if (id != null && title != null && String(title).trim()) {
        titles.set(String(id), String(title));
      }
    }
    return titles;
  }, [contentItems.rows]);

  const hits = useMemo(
    () =>
      groupedSearchHits({
        assets,
        collections: collections.rows,
        contentTitles,
        entries: entries.rows,
        faces: faces.rows,
        matches,
        parties: parties.rows,
        places: places.rows,
        query: term,
      }),
    [
      assets,
      collections.rows,
      contentTitles,
      entries.rows,
      faces.rows,
      matches,
      parties.rows,
      places.rows,
      term,
    ]
  );

  const openHit = (hit: SearchHit): void => {
    const target = hit.target;
    // Each branch names its own screen and params — a single dynamic
    // `navigate(target.screen, target.params)` would typecheck against the
    // union rather than against the pair, which is how a labelled row starts
    // opening the wrong thing.
    if (target.screen === "PhotoStateView")
      navigation.navigate("PhotoStateView", target.params);
    else if (target.screen === "AlbumDetail")
      navigation.navigate("AlbumDetail", target.params);
    else if (target.screen === "PhotoLightbox")
      navigation.navigate("PhotoLightbox", target.params);
    else navigation.navigate("PlacesMap");
  };

  const asked = Boolean(term.trim());

  return (
    <View style={styles.fill}>
      {/* One query box (proto:4257). Nothing else is a control on this shelf. */}
      <View style={styles.fieldRow}>
        <View style={styles.field}>
          <Icon name="search" size={16} color={colors.textSoft} />
          <TextInput
            accessibilityLabel="Search photographs"
            autoFocus
            value={term}
            onChangeText={onTerm}
            placeholder="Search photographs, people, places, albums"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
          />
          {term ? (
            // Clear is mono underlined TEXT (proto:4146-4147), not an icon: it
            // is a word for what it does, and an ✕ in a field is ambiguous
            // between "clear this" and "close this".
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear the query"
              onPress={() => setTerm("")}
              style={styles.clearTarget}
            >
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <ReplicaStatusBar />

      {unreachable ? (
        <Panel
          styles={styles}
          net
          eyebrow={UNREACHABLE_EYEBROW}
          title={UNREACHABLE_TITLE}
          body={UNREACHABLE_BODY}
          facts={UNREACHABLE_FACTS}
          action="Retry"
          onAction={() => {
            setSearching(true);
            setAttempt((value) => value + 1);
          }}
        />
      ) : asked ? (
        searching ? (
          // Determinate: the library's size is known, so it is stated. There is
          // no spinner anywhere in this product (§18).
          <View style={styles.center}>
            <Text style={styles.status}>
              Searching {assets.length}{" "}
              {assets.length === 1 ? "photograph" : "photographs"}…
            </Text>
          </View>
        ) : matches.length || hits.length ? (
          <View style={styles.fill}>
            <View style={styles.head}>
              <Text style={styles.headTitle}>Results</Text>
              <Text style={styles.headCount}>{matches.length}</Text>
            </View>
            {/* The grouped hits are the substance of §9: a member who types a
                name gets the PERSON, the PLACE, the ALBUM — each with the
                surface that owns it one tap away — above the photographs. */}
            {hits.map((hit) => (
              <Pressable
                key={hit.key}
                accessibilityRole="button"
                accessibilityLabel={`Open ${hit.label}`}
                onPress={() => openHit(hit)}
                style={styles.hit}
              >
                <View style={styles.hitText}>
                  <Text numberOfLines={1} style={styles.hitLabel}>
                    {hit.label}
                  </Text>
                  <Text numberOfLines={1} style={styles.hitSub}>
                    {hit.sub}
                  </Text>
                </View>
                {hit.meta ? (
                  <Text style={styles.hitMeta}>{hit.meta}</Text>
                ) : null}
                <Text style={styles.hitOpen}>Open →</Text>
              </Pressable>
            ))}
            <PhotoTimeline
              sections={sections}
              selection={new Set()}
              onSelectionChange={() => undefined}
              onOpen={(asset) =>
                navigation.navigate("PhotoLightbox", { assetId: asset.id })
              }
              refreshing={refreshing}
              onRefresh={refreshNow}
            />
            <Text style={styles.foot}>
              {matches.length} {matches.length === 1 ? "result" : "results"} ·{" "}
              {SEARCH_SCOPE}
            </Text>
          </View>
        ) : (
          <Panel
            styles={styles}
            eyebrow={NONE_EYEBROW}
            title={`Nothing matches “${term.trim()}”`}
            body={NONE_BODY}
            action={NONE_ACTION}
            onAction={() => setTerm("")}
          />
        )
      ) : (
        <ScrollView contentContainerStyle={styles.resting}>
          <Panel
            styles={styles}
            eyebrow={RESTING_EYEBROW}
            title={RESTING_TITLE}
            body={RESTING_BODY}
          />
          <View style={styles.examples}>
            {SEARCH_EXAMPLES.map((example) => (
              <Pressable
                key={example}
                accessibilityRole="button"
                accessibilityLabel={`Search for ${example}`}
                onPress={() => onTerm(example)}
                style={styles.example}
              >
                <Text style={styles.exampleText}>{example}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

/** The shelf's stated states, all drawn the same way: eyebrow, title, body, an
 *  optional facts table, an optional single action. `net` is the unreachable
 *  border — the one colour in this app that means "the network said no". */
function Panel({
  styles,
  eyebrow,
  title,
  body,
  facts,
  action,
  onAction,
  net = false,
}: {
  styles: Styles;
  eyebrow: string;
  title: string;
  body: string;
  facts?: readonly (readonly [string, string])[];
  action?: string;
  onAction?: () => void;
  net?: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.panel, net ? styles.panelNet : null]}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.panelTitle}>{title}</Text>
      <Text style={styles.panelBody}>{body}</Text>
      {facts?.length ? (
        <View style={styles.facts}>
          {facts.map(([label, value]) => (
            <View key={label} style={styles.fact}>
              <Text style={styles.factLabel}>{label}</Text>
              <Text style={styles.factValue}>{value}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action}
          onPress={onAction}
          style={styles.actionTarget}
        >
          <Text style={styles.actionText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actionText: { ...t("control"), color: colors.text },
    actionTarget: { justifyContent: "center", minHeight: 44 },
    center: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: spacing[6],
    },
    clearText: {
      ...t("mono"),
      color: colors.textSoft,
      textDecorationLine: "underline",
    },
    clearTarget: { justifyContent: "center", minHeight: 34 },
    example: {
      borderColor: colors.line,
      borderRadius: 999,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: 34,
      paddingHorizontal: spacing[3],
    },
    examples: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing[2],
      paddingHorizontal: spacing[4],
    },
    exampleText: { ...t("mono"), color: colors.textSoft },
    eyebrow: { ...t("eyebrow"), color: colors.textSoft },
    fact: {
      flexDirection: "row",
      gap: spacing[2],
      justifyContent: "space-between",
    },
    factLabel: { ...t("small"), color: colors.textSoft },
    factValue: { ...t("mono"), color: colors.text, flexShrink: 1 },
    facts: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      gap: spacing[1],
      paddingTop: spacing[2],
    },
    // §9's field: 34px tall, 7px radius (proto:4140-4152).
    field: {
      alignItems: "center",
      backgroundColor: colors.bgSunken,
      borderColor: colors.line,
      borderRadius: 7,
      borderWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[2],
      height: 34,
      paddingHorizontal: spacing[2],
    },
    fieldRow: { paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
    fill: { flex: 1 },
    foot: {
      ...t("mono"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[2],
    },
    head: {
      alignItems: "baseline",
      flexDirection: "row",
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    headCount: { ...t("mono"), color: colors.textSoft },
    headTitle: { ...t("eyebrow"), color: colors.text },
    hit: {
      alignItems: "center",
      borderBottomColor: colors.line,
      borderBottomWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      minHeight: 44,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[2],
    },
    hitLabel: { ...t("control"), color: colors.text },
    hitMeta: { ...t("mono"), color: colors.textSoft },
    hitOpen: { ...t("control"), color: colors.link },
    hitSub: { ...t("small"), color: colors.textSoft },
    hitText: { flex: 1, minWidth: 0 },
    input: {
      ...t("body"),
      color: colors.text,
      flex: 1,
      height: "100%",
      paddingVertical: 0,
    },
    panel: {
      borderColor: colors.line,
      borderRadius: 12,
      borderWidth: borders.hairline,
      gap: spacing[2],
      marginHorizontal: spacing[4],
      padding: spacing[4],
    },
    panelBody: { ...t("small"), color: colors.textSoft },
    panelNet: { borderColor: colors.net },
    panelTitle: { ...t("display"), color: colors.text },
    resting: { gap: spacing[4], paddingBottom: spacing[6] },
    safe: { flex: 1 },
    status: { ...t("mono"), color: colors.textSoft },
  });
