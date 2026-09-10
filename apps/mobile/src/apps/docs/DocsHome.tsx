// The Docs stack's home (Binding Layer v12 handoff Part 2; #821).
//
// The claimed band's shelf destinations — All, Folders, Starred, Search, plus
// Coming due off the More sheet — all live on this one screen, so a band tap
// from a pushed route navigates here with the destination named rather than
// pushing a second copy (`DocsScreen.tsx`'s `popTo`). React Navigation updates
// params on a mounted screen WITHOUT remounting it, so the param is mirrored
// into state through an effect, exactly as `PhotosHome` does.
//
// The All shelf is the drive: filter chips that COMPOSE (each axis its own
// menu, `Clear` only once something is filtered), a sort menu, and the
// list/grid pair remembered together with the sort (`docs-view-prefs.ts`).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import {
  CLEAR_FILTERS,
  SORT_OPTIONS,
} from "@centraid/blueprints/apps/docs/drive-copy";
import type { FilterAxis } from "@centraid/blueprints/apps/docs/drive-copy";
import {
  applyFilters,
  filtersActive,
  liveAxes,
  liveOptions,
  NO_FILTERS,
} from "@centraid/blueprints/apps/docs/filters";
import type { DriveFilters } from "@centraid/blueprints/apps/docs/filters";
import { STARRED } from "@centraid/blueprints/apps/docs/shelves";
import {
  captionFor,
  shelfCopy,
} from "@centraid/blueprints/apps/docs/view-copy";

import AnchoredMenu from "../../kit/components/AnchoredMenu";
import type { MenuAnchor, MenuGroup } from "../../kit/components/AnchoredMenu";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import AppPlace from "../../kit/rooms/AppPlace";
import type { RoomSelection } from "../../kit/rooms/room-contracts";
import {
  borders,
  pageMargin,
  radii,
  spacing,
  t,
  useTheme,
} from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { resolveAppMeta } from "../../lib/gateway";
import type { DocsScreenProps } from "../../navigation";
import { allStatus, SHARED_TITLE } from "./docs-copy";
import { sortDocuments } from "./docs-projection";
import { useDocsRoom } from "./docs-room";
import { useDriveViewPrefs } from "./docs-view-prefs";
import DocsDueView from "./DocsDueView";
import DocsFoldersView from "./DocsFoldersView";
import DocsSearchView from "./DocsSearchView";
import DocsSharedView from "./DocsSharedView";
import DocsStarredView from "./DocsStarredView";
import DriveList from "./DriveList";
import { useDocs } from "./useDocs";

/** The app's own mark and hue, from the one builtin table. */
const DOCS = resolveAppMeta({ id: "docs" });

type ShelfDestination =
  | "all"
  | "folders"
  | "starred"
  | "shared"
  | "due"
  | "search";

export default function DocsHome({
  route,
  navigation,
}: DocsScreenProps<"DocsHome">): React.JSX.Element {
  const drive = useDocs();

  const [destination, setDestination] = useState<ShelfDestination>(
    route.params?.destination ?? "all"
  );
  const routeDestination = route.params?.destination;
  useEffect(() => {
    if (routeDestination)
      queueMicrotask(() => setDestination(routeDestination));
  }, [routeDestination]);

  // The band lights the place the member is looking at.
  const room = useDocsRoom(destination);

  const [filters, setFilters] = useState<DriveFilters>(NO_FILTERS);
  const [prefs, updatePrefs] = useDriveViewPrefs();
  // Owned here, not in `DriveList`: the control that turns it on is the app
  // bar's, and the app bar belongs to the screen.
  const [selecting, setSelecting] = useState(false);
  // SELECTION IS A MODE (#1015, D5, audit docs/findings#2): the head swaps in
  // place to the count and the one way out, the controls row stands down, and
  // the band below dims. Before this the drive carried the bulk bar AND a live
  // five-tab band at the foot, and one tap navigated away mid-selection.
  const [selection, setSelection] = useState<RoomSelection | undefined>();

  const active = useMemo(
    () => drive.documents.filter((doc) => !doc.trashed),
    [drive.documents]
  );
  // `applyFilters` only ever narrows the array it was given (a chain of
  // `filter` calls), so the mobile row type survives the pass.
  const filtered = useMemo(
    () => applyFilters(active, filters) as typeof active,
    [active, filters]
  );
  const sorted = useMemo(
    () => sortDocuments(filtered, prefs.sortKey, prefs.sortDir),
    [filtered, prefs.sortKey, prefs.sortDir]
  );

  // §2's Title column via the shared table: All and Folders title "Docs";
  // Search and Starred title themselves; Coming due and Shared are their own
  // places, and neither has a shelf in the shared table to be titled from.
  const headTitle =
    destination === "due"
      ? "Coming due"
      : destination === "shared"
        ? SHARED_TITLE
        : destination === "search"
          ? shelfCopy("built-in:search").title
          : destination === "starred"
            ? shelfCopy(STARRED).title
            : shelfCopy(null).title;

  return (
    <AppPlace
      {...(destination === "all" && !selecting
        ? {
            // The drive's PRIMARY act, one tap from the set — a file app whose
            // way in is three taps down an overflow sheet has buried the
            // reason it exists.
            action: {
              label: "New",
              onPress: () => navigation.navigate("DocsAdd"),
            },
          }
        : {})}
      app={{
        color: DOCS.color,
        iconKey: DOCS.iconKey,
        title: headTitle,
      }}
      band={room.band}
      chrome={room.chrome}
      onBack={() => navigation.popTo("Home")}
      overlay={room.overlay}
      {...(selection ? { selection } : {})}
      {...(destination === "all" && !selecting
        ? {
            // Both acts sit on the DRIVE only. Search and Coming due have no
            // set to choose from, Folders already carries its own New folder —
            // two differently-scoped "New"s on one screen is a question, not
            // an affordance — and Starred is a VIEW of the drive: a "New"
            // there would have to promise a star it cannot set before the
            // document exists.
            secondary: { label: "Select", onPress: () => setSelecting(true) },
          }
        : {})}
    >
      <ReplicaStatusBar />
      {destination === "all" ? (
        <AllShelf
          drive={drive}
          docs={sorted}
          activeCount={active.length}
          filters={filters}
          onFilters={setFilters}
          rows={active}
          view={prefs.view}
          sortKey={prefs.sortKey}
          sortDir={prefs.sortDir}
          onPrefs={updatePrefs}
          selecting={selecting}
          onSelectingChange={setSelecting}
          onSelection={setSelection}
        />
      ) : destination === "folders" ? (
        <DocsFoldersView drive={drive} />
      ) : destination === "starred" ? (
        <DocsStarredView drive={drive} />
      ) : destination === "shared" ? (
        <DocsSharedView drive={drive} />
      ) : destination === "due" ? (
        <DocsDueView />
      ) : (
        <DocsSearchView drive={drive} />
      )}
    </AppPlace>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The All shelf's controls + rows
// ───────────────────────────────────────────────────────────────────────────

function AllShelf({
  drive,
  docs,
  activeCount,
  filters,
  onFilters,
  rows,
  view,
  sortKey,
  sortDir,
  onPrefs,
  selecting,
  onSelectingChange,
  onSelection,
}: {
  drive: ReturnType<typeof useDocs>;
  docs: ReturnType<typeof useDocs>["documents"];
  activeCount: number;
  filters: DriveFilters;
  onFilters: (next: DriveFilters) => void;
  /** The unfiltered active set — the People axis derives its options from it. */
  rows: ReturnType<typeof useDocs>["documents"];
  view: "list" | "grid";
  sortKey: (typeof SORT_OPTIONS)[number]["key"];
  sortDir: 1 | -1;
  onPrefs: (next: {
    view?: "list" | "grid";
    sortKey?: (typeof SORT_OPTIONS)[number]["key"];
    sortDir?: 1 | -1;
  }) => void;
  selecting: boolean;
  onSelectingChange: (active: boolean) => void;
  onSelection: (selection: RoomSelection | undefined) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [openAxis, setOpenAxis] = useState<FilterAxis["id"] | "sort" | null>(
    null
  );
  // The card hangs off the press point itself: several chips share one menu
  // host, and a ref can only be attached to one control at a time. The touch's
  // window coordinates are the one rectangle every chip can report.
  const [anchor, setAnchor] = useState<MenuAnchor | undefined>(undefined);
  const openFrom = useCallback(
    (
      axis: FilterAxis["id"] | "sort",
      event: { nativeEvent: { pageX: number; pageY: number } }
    ): void => {
      setAnchor({
        x: event.nativeEvent.pageX,
        y: event.nativeEvent.pageY,
        width: 1,
        height: 1,
      });
      setOpenAxis(axis);
    },
    []
  );

  // `source` is dropped HERE, not from the shared axis table: the web drive
  // still offers it, and this seat's three custody options ("On this device",
  // "Gateway only", "In the backup") ask the member to reason about where
  // bytes live before they have reason to care.
  const axes = liveAxes(rows).filter((axis) => axis.id !== "source");
  const anyFilter = filtersActive(filters);
  const sortNow =
    SORT_OPTIONS.find(
      (option) => option.key === sortKey && option.dir === sortDir
    ) ?? SORT_OPTIONS[0]!;

  const menuGroups: MenuGroup[] = useMemo(() => {
    if (openAxis === null) return [];
    if (openAxis === "sort") {
      return [
        {
          key: "sort",
          rows: SORT_OPTIONS.map((option) => ({
            key: `${option.key}:${option.dir}`,
            label: `${option.name} · ${option.sub}`,
            checked: option.key === sortKey && option.dir === sortDir,
            onSelect: () =>
              onPrefs({ sortKey: option.key, sortDir: option.dir }),
          })),
        },
      ];
    }
    const axis = axes.find((candidate) => candidate.id === openAxis);
    if (!axis) return [];
    return [
      {
        key: axis.id,
        rows: liveOptions(axis, rows).map((option) => ({
          key: option,
          label: option,
          checked: filters[axis.id] === option,
          // Choosing the chosen option again clears the axis — the chip is a
          // toggle over one selection, never a second control.
          onSelect: () =>
            onFilters({
              ...filters,
              [axis.id]: filters[axis.id] === option ? null : option,
            }),
        })),
      },
    ];
  }, [axes, filters, onFilters, onPrefs, openAxis, rows, sortDir, sortKey]);

  return (
    <View style={styles.shelf}>
      {/* The filter, sort and arrangement row describes the set being READ.
          While a set is being chosen the member is no longer reading it, and
          leaving these live was the second half of the two-bars defect. */}
      {selecting ? null : (
        <View style={styles.controls}>
          {/* `flex: 1` on the SCROLLER, not its content: without it the row's
            fixed siblings and this list negotiate width against each other and
            a chip is left sliced at the sort control's edge. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipScroll}
            contentContainerStyle={styles.chipRow}
          >
            {axes.map((axis) => {
              const chosen = filters[axis.id];
              return (
                <Pressable
                  key={axis.id}
                  accessibilityRole="button"
                  accessibilityLabel={axis.label}
                  accessibilityState={{ selected: chosen !== null }}
                  onPress={(event) => openFrom(axis.id, event)}
                  style={[styles.chip, chosen ? styles.chipOn : undefined]}
                >
                  <Text
                    style={[
                      styles.chipLabel,
                      chosen ? styles.chipLabelOn : undefined,
                    ]}
                  >
                    {chosen ?? axis.label}
                  </Text>
                </Pressable>
              );
            })}
            {anyFilter ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={CLEAR_FILTERS}
                onPress={() => onFilters(NO_FILTERS)}
                style={styles.clear}
              >
                <Text style={styles.clearLabel}>{CLEAR_FILTERS}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Sort: ${sortNow.name}, ${sortNow.sub}`}
            onPress={(event) => openFrom("sort", event)}
            style={styles.sortButton}
          >
            {/* The glyph alone. The order it names lives in the menu this
              opens, and the control's `accessibilityLabel` still speaks it. */}
            <Icon name="SwitchVert" size={18} color={colors.text} />
          </Pressable>
          <View style={styles.viewPair}>
            {(["list", "grid"] as const).map((candidate) => {
              const on = view === candidate;
              return (
                <Pressable
                  key={candidate}
                  accessibilityRole="button"
                  accessibilityLabel={
                    candidate === "list" ? "List view" : "Grid view"
                  }
                  accessibilityState={{ selected: on }}
                  onPress={() => onPrefs({ view: candidate })}
                  style={[styles.viewItem, on ? styles.viewItemOn : undefined]}
                >
                  <Icon
                    name={candidate === "list" ? "List" : "Grid"}
                    size={16}
                    color={on ? colors.text : colors.textFaint}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      <DriveList
        shelf={null}
        docs={docs}
        folders={drive.folders}
        loading={drive.loading}
        connection={drive.connection}
        {...(drive.error ? { error: drive.error } : {})}
        {...(drive.unavailableReason
          ? { unavailableReason: drive.unavailableReason }
          : {})}
        offline={drive.offline}
        refresh={drive.refresh}
        view={view}
        empty={{
          filtered: filtersActive(filters),
          driveIsEmpty: activeCount === 0,
        }}
        caption={captionFor(null, { offline: drive.offline })}
        status={allStatus(activeCount)}
        selecting={selecting}
        onSelectingChange={onSelectingChange}
        onSelection={onSelection}
      />

      <AnchoredMenu
        visible={openAxis !== null}
        anchor={anchor}
        groups={menuGroups}
        onClose={() => setOpenAxis(null)}
      />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    chip: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.pill,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: 32,
      paddingHorizontal: spacing[3],
    },
    chipLabel: { ...t("control"), color: colors.textSoft },
    chipLabelOn: { color: colors.onAccent },
    chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      paddingEnd: 8,
    },
    chipScroll: { flex: 1 },
    clear: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 32,
      paddingHorizontal: spacing[2],
    },
    clearLabel: {
      ...t("control"),
      color: colors.text,
      textDecorationLine: "underline",
    },
    controls: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      paddingBottom: 8,
      paddingHorizontal: pageMargin,
    },
    headAction: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: 36,
      paddingHorizontal: spacing[3],
    },
    headActionLabel: { ...t("control"), color: colors.text },
    headPrimary: {
      alignItems: "center",
      borderRadius: radii.md,
      flexDirection: "row",
      gap: 6,
      justifyContent: "center",
      minHeight: 36,
      paddingHorizontal: spacing[3],
    },
    headPrimaryLabel: { ...t("control") },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      minHeight: 44,
      paddingHorizontal: pageMargin,
      paddingVertical: 4,
    },
    shelf: { flex: 1 },
    sortButton: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    title: { ...t("title"), color: colors.text, flex: 1 },
    viewItem: {
      alignItems: "center",
      borderRadius: radii.sm,
      height: 32,
      justifyContent: "center",
      width: 38,
    },
    viewItemOn: {
      backgroundColor: colors.bg,
      borderColor: colors.line,
      borderWidth: borders.hairline,
    },
    viewPair: {
      backgroundColor: colors.bgSunken,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      flexDirection: "row",
      gap: 2,
      padding: 2,
    },
  });
