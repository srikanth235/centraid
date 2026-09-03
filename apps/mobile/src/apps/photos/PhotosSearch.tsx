// Search on the phone (Photos v4 handoff §9, §14, §18, proto:4256-4276).
// governance: allow-repo-hygiene file-size-limit The #712 search destination remains one cohesive query/results state machine; #716 extracts its reusable empty states.
//
// Search is a BAND DESTINATION, never a pushed screen: proto:4953-4954's
// `appBandOn` excludes only the viewer, zoom, video, slideshow and the editor,
// so the band must stay up with Search current.
//
// ONE query box (proto:4257), no chip rail and no date fields, over five
// states — resting, searching, results, no results, and unreachable, which is
// deliberately not one of the four because search will not pretend to have
// looked. Copy is the web shell's verbatim wherever the handoff gives a string;
// where it does not, see `SEARCH_SCOPE`.
//
// The field docks at the BOTTOM (#712) — the surface's only control, sitting
// above the keyboard. `PhotosHome` sizes this view as a flex sibling above
// `PhotosBand`, so the field lands flush against the band.

import React, { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

import { PHOTOS_SEARCH_PLACEHOLDER } from "@centraid/blueprints/apps/photos/shared-copy";
import { OnlineOnlyError } from "@centraid/client/replica/native";

import Icon from "../../kit/components/Icon";
import { Text, TextInput } from "../../kit/components/NativeText";
import TopSafeArea from "../../kit/components/TopSafeArea";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import { TEST_IDS } from "../../kit/test-ids";
import { borders, spacing, t, useTheme, radii } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { authHeader } from "../../lib/gateway";
import type { PhotosScreenProps } from "../../navigation";
import PhotosSearchEmptyState from "./PhotosSearchEmptyState";
import PhotosSearchRestingState from "./PhotosSearchRestingState";
import PhotoTimeline from "./PhotoTimeline";
import { groupedSearchHits, reachableAssetIds } from "./search-hits";
import type { SearchHit } from "./search-hits";
import { sectionPhotoAssets } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

/** Verbatim proto:4269, and the same five the web shell offers — examples that
 *  differ per surface teach that the surfaces search different things. */
const SEARCH_EXAMPLES: readonly string[] = [
  "ana at the coast",
  "videos from June",
  "Pemberton kitchen",
  "scans from the solicitor",
  "photographs with no place",
];

/** Diverges from proto:3961's "the live library" on purpose: `session.search`
 *  resolves against the replica's eager-metadata surface (`REPLICA_LOCAL_SEARCH`)
 *  and every group below comes from replica rows, so the live-library claim is
 *  a sentence this code does not keep. */
const SEARCH_SCOPE = "searched the whole replica on this device";

const UNREACHABLE_EYEBROW = "Cannot reach the vault";
const UNREACHABLE_TITLE = "Search needs the gateway";
/** proto:4274, gateway name generalised — this client does not know it is
 *  talking to `home-gateway`. */
const UNREACHABLE_BODY =
  "The index lives on the gateway, which is unreachable. The timeline still browses from this device; search does not, and will not pretend to have looked.";
const UNREACHABLE_FACTS: readonly (readonly [string, string])[] = [
  ["what still works", "browsing, albums, favorites, captions"],
  ["what does not", "search, people, places"],
];

/** One hit off `POST …/enrich/semantic-search` (#721). */
interface SemanticHit {
  assetId: string;
  contentId: string;
  score: number;
}

type Nav = PhotosScreenProps<"PhotosHome">["navigation"];

/** Dead registration: nothing pushes this route — the band renders
 *  `PhotosSearchView` in place. Kept only so `App.tsx` does not dangle. */
export default function PhotosSearch({
  navigation,
}: PhotosScreenProps<"PhotosSearch">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ReplicaStatusBar />
      <PhotosSearchView navigation={navigation as unknown as Nav} />
    </TopSafeArea>
  );
}

export function PhotosSearchView({
  navigation,
}: {
  navigation: Nav;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { session, gatewayBase } = useReplica();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const { assets } = usePhotoTimeline();
  const [term, setTerm] = useState("");
  const [contentIds, setContentIds] = useState<Set<string>>();
  const [searching, setSearching] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  // Derived data enriches, never gates (#721): `undefined` covers every reason
  // there is nothing to show, and this state must never feed `unreachable` or
  // `searching` — the FTS grid stays as capable if the fetch never lands.
  const [semanticHits, setSemanticHits] = useState<SemanticHit[]>();
  // Bumped by Retry; the query effect depends on it, so Retry re-runs the SAME
  // query rather than navigating the member away.
  const [attempt, setAttempt] = useState(0);

  const collections = useReplicaQuery(
    "photos",
    useMemo(() => ({ acceptTruncation: true, entity: "core.collection" }), [])
  );
  const entries = useReplicaQuery(
    "photos",
    useMemo(
      () => ({ acceptTruncation: true, entity: "core.collection_entry" }),
      []
    )
  );
  const faces = useReplicaQuery(
    "photos",
    useMemo(() => ({ acceptTruncation: true, entity: "media.face_region" }), [])
  );
  const parties = useReplicaQuery(
    "photos",
    useMemo(() => ({ acceptTruncation: true, entity: "core.party" }), [])
  );
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ acceptTruncation: true, entity: "core.place" }), [])
  );
  const contentItems = useReplicaQuery(
    "photos",
    useMemo(() => ({ acceptTruncation: true, entity: "core.content_item" }), [])
  );

  // `searching` is set in the handler, never in the effect, so no effect writes
  // state synchronously during a render commit.
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

  // Separate from the FTS effect on purpose: a different gateway route, whose
  // outcome must never touch `searching`/`unreachable` (#721).
  useEffect(() => {
    let cancelled = false;
    const trimmed = term.trim();
    const timeout = setTimeout(() => {
      if (!trimmed || !session || !gatewayBase) {
        setSemanticHits(undefined);
        return;
      }
      void fetch(`${gatewayBase}/centraid/_vault/enrich/semantic-search`, {
        method: "POST",
        headers: { ...authHeader(), "content-type": "application/json" },
        body: JSON.stringify({ query: trimmed, limit: 30 }),
      })
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{
                status: string;
                hits?: SemanticHit[];
              }>)
            : Promise.reject(
                new Error(`semantic search failed (HTTP ${response.status})`)
              )
        )
        .then((body) => {
          if (cancelled) return;
          setSemanticHits(body.status === "ok" ? (body.hits ?? []) : undefined);
        })
        .catch(() => {
          // A failure and an "unavailable" model read the same: no group.
          if (!cancelled) setSemanticHits(undefined);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [attempt, gatewayBase, session, term]);

  const matches = useMemo(
    () =>
      contentIds
        ? assets.filter(
            (asset) => asset.contentId && contentIds.has(asset.contentId)
          )
        : [],
    [assets, contentIds]
  );

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
        ...(semanticHits ? { semanticHits } : {}),
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
      semanticHits,
      term,
    ]
  );

  // Title matches PLUS everything reachable through a group the query hit
  // (#712) — typing "Tahoe" must return the album's photographs, not an empty
  // grid under a row saying the album exists. Filter the library ONCE rather
  // than append to `matches`: that is what keeps the union deduplicated and in
  // the newest-first order `sectionPhotoAssets` expects.
  const reached = useMemo(() => reachableAssetIds(hits), [hits]);
  const shown = useMemo(() => {
    if (!reached.size) return matches;
    const matched = new Set(matches.map((asset) => asset.id));
    return assets.filter(
      (asset) =>
        matched.has(asset.id) ||
        Boolean(asset.assetId && reached.has(asset.assetId))
    );
  }, [assets, matches, reached]);
  const sections = useMemo(() => sectionPhotoAssets(shown), [shown]);

  /** Every row on the screen, hits included — never `matches.length`, which
   *  draws `RESULTS 0` above a real album row. */
  const resultCount = hits.length + shown.length;

  const openHit = (hit: SearchHit): void => {
    const target = hit.target;
    // One branch per screen: a dynamic `navigate(target.screen, target.params)`
    // typechecks against the union, not the pair.
    if (target.screen === "PhotoStateView")
      navigation.navigate("PhotoStateView", target.params);
    else if (target.screen === "AlbumDetail")
      navigation.navigate("AlbumDetail", target.params);
    else if (target.screen === "PhotoLightbox")
      navigation.navigate("PhotoLightbox", target.params);
    // The no-location bucket (#816) has no pin to send the member to a map for.
    else if (target.screen === "PlaceDetail")
      navigation.navigate("PlaceDetail", target.params);
    else navigation.navigate("PlacesMap");
  };

  const asked = Boolean(term.trim());
  // Only before anything is typed: an example while the vault is unreachable
  // would start a search that cannot run.
  const showExamples = !asked && !unreachable;

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      // iOS only: Android resizes the window itself, so a behavior there would
      // double-count the keyboard.
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* NO `<ReplicaStatusBar/>` here: `PhotosHome` renders one above every
          band destination, and two bars mounted at different times give two
          contradictory answers to "how fresh is this?". The standalone route
          above owns its own bar because nothing renders one for it. */}

      {/* State content scrolls here; the field itself never moves. */}
      <View style={styles.fill}>
        {unreachable ? (
          <ScrollView contentContainerStyle={styles.contentPad}>
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
          </ScrollView>
        ) : asked ? (
          searching ? (
            // Determinate: the library's size is known, so state it. No spinner
            // anywhere in this product (§18).
            <View style={styles.center}>
              <Text style={styles.status}>
                Searching {assets.length}{" "}
                {assets.length === 1 ? "photograph" : "photographs"}…
              </Text>
            </View>
          ) : resultCount ? (
            <View style={styles.fill}>
              <View style={styles.head}>
                <Text style={styles.headTitle}>Results</Text>
                <Text style={styles.headCount}>{resultCount}</Text>
              </View>
              {/* §9: the person, place and album rows sit ABOVE the
                  photographs, each one tap from the surface that owns it. */}
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
                {resultCount} {resultCount === 1 ? "result" : "results"} ·{" "}
                {SEARCH_SCOPE}
              </Text>
            </View>
          ) : (
            <PhotosSearchEmptyState
              query={term.trim()}
              onClear={() => setTerm("")}
            />
          )
        ) : (
          <PhotosSearchRestingState />
        )}
      </View>

      {/* Anchored to the field they fill, outside the scrolling read. */}
      {showExamples ? (
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
      ) : null}

      {/* One query box (proto:4257), docked at the BOTTOM of the surface
          (#712). Nothing else is a control on this shelf. */}
      <View style={styles.fieldRow}>
        <View style={styles.field}>
          <Icon name="search" size={16} color={colors.textSoft} />
          <TextInput
            accessibilityLabel="Search photographs"
            testID={TEST_IDS.photos.searchField}
            autoFocus
            value={term}
            onChangeText={onTerm}
            placeholder={PHOTOS_SEARCH_PLACEHOLDER}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
          />
          {term ? (
            // Mono underlined TEXT (proto:4146-4147), never an ✕ — ambiguous
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
    </KeyboardAvoidingView>
  );
}

/** `net` draws the unreachable border — the one colour in this app that means
 *  "the network said no". */
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
      borderRadius: radii.pill,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: 34,
      paddingHorizontal: spacing[3],
    },
    contentPad: {
      gap: spacing[4],
      paddingBottom: spacing[4],
      paddingTop: spacing[4],
    },
    examples: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
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
      borderRadius: radii.md,
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
    // Exactly one line's height, no vertical padding, Android font padding off
    // (#712). A TextInput stretched to the field's 34px centres against the
    // iOS control box, not the glyph box, and drops off the magnifier's line.
    input: {
      ...t("body"),
      color: colors.text,
      flex: 1,
      height: t("body").lineHeight,
      includeFontPadding: false,
      paddingVertical: 0,
      textAlignVertical: "center",
    },
    panel: {
      borderColor: colors.line,
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: spacing[2],
      marginHorizontal: spacing[4],
      padding: spacing[4],
    },
    panelBody: { ...t("small"), color: colors.textSoft },
    panelNet: { borderColor: colors.net },
    panelTitle: { ...t("display"), color: colors.text },
    safe: { flex: 1 },
    status: { ...t("mono"), color: colors.textSoft },
  });
