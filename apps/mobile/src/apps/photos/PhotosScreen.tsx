// The frame every Photos surface sits in (v4 handoff §F, proto:4950-4990).
//
// THE DEFECT THIS EXISTS TO FIX. The claimed band used to be rendered by
// exactly one screen — `PhotosHome` — so every destination that screen pushed
// (the Library index, one album, Backup, Duplicates, Trash, Favorites) arrived
// with NO band and no Home capsule. The only way out was the OS back gesture.
// §F's whole argument is that the way OUT of an app must be no harder to reach
// than the app's own tabs; a stack of dead ends is the opposite of that.
//
// proto:4953-4954 states the rule as a predicate: `appBandOn` excludes ONLY
// the viewer, zoom, video, slideshow and the editor — and, while a selection
// is live, swaps the band for the selection bar (`…&&!sel`). Everything else
// in Photos renders the band. This component IS that predicate: a screen that
// wraps itself in it cannot forget the band, cannot forget the capsule, and
// cannot forget to reserve the band's height out of its own content.
//
// Three things live here and nowhere else:
//
//   1. THE FRAME. Safe-area top inset (explicit, not `SafeAreaView edges` —
//      inside the fullScreenModal cover this stack presents, the edges variant
//      intermittently resolves a zero top inset while the hook stays correct),
//      Photos' `mat` page tone, and the content slot as a `flex:1` sibling
//      ABOVE the bar rather than a surface the bar floats over, so content
//      ends above the band instead of scrolling under it (§G).
//   2. THE BAND, with this screen's destination marked current, plus the More
//      sheet its fifth target opens. A pushed screen's band tap NAVIGATES to
//      the stack's home rather than pushing deeper — otherwise "Library" from
//      inside an album would grow the stack every time it was tapped.
//   3. THE SELECTION BAR that replaces the band while a selection is live.
//
// WHAT IT DOES NOT OWN: the screen's head. Every screen keeps its own title,
// its count, its Done affordance and its back chevron (where it has a genuine
// parent), because those differ per screen and the band does not.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  SELECTION_ACTION_TARGET,
  buildSelectionActions,
  selectionBarReason,
} from "@centraid/blueprints/apps/_shared/selection-engine";
import type {
  SelectionHandler,
  SelectionShelfKind,
} from "@centraid/blueprints/apps/_shared/selection-engine";

import {
  BAND_BORDER,
  BAND_INSET,
  bandSurfaceStyle,
} from "../../kit/band-surface";
import { useBandOwner } from "../../kit/band/band-owner";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { PhotosShellNavigation } from "../../navigation";
import { resolveMoreRowRoute } from "./photos-band";
import type { BandDestinationKey, PhotosMoreRowKey } from "./photos-band";
import PhotosBand from "./PhotosBand";
import PhotosMoreSheet from "./PhotosMoreSheet";

/** What a screen hands the shell so the band can become a selection bar. */
export interface PhotosSelectionProps {
  count: number;
  shelf: SelectionShelfKind;
  /** The third target's caption — `Copy to ⟨destination⟩`, resolved by the
   *  screen's own `useCopyToVault` (issue #726: the destination is the
   *  caller's to resolve, never derived by the engine). */
  copyLabel: string;
  /** Non-null when the scope refuses writes — stated inline, never hidden. */
  readOnlyReason: string | null;
  favorite: SelectionHandler;
  addToAlbum: SelectionHandler;
  share: SelectionHandler;
  download: SelectionHandler;
  trash: SelectionHandler;
}

export interface PhotosScreenProps {
  /** Which of the app's four this surface belongs under. A More-sheet
   *  destination (Trash, Favorites, Duplicates, Storage) is `more`: the sheet
   *  is how a member got here, and marking one of the other three would point
   *  at a shelf they are not looking at. */
  current: BandDestinationKey;
  children: React.ReactNode;
  /** Live selection. When `count` is above zero the band is REPLACED by the
   *  selection bar (proto:4953 `…&&!sel`), never stacked above it. */
  selection?: PhotosSelectionProps;
}

export default function PhotosScreen({
  current,
  children,
  selection,
}: PhotosScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<PhotosShellNavigation>();
  const [moreOpen, setMoreOpen] = useState(false);
  // The member's band-owner choice, per device — the same latch (and the same
  // key) `PhotosHome` reads, so handing the band back on one Photos surface
  // hands it back on all of them rather than on whichever screen was open.
  // The FRAME's latch, not Photos' (issue #712 E3). The hydrate-into-state
  // dance this replaced lived in two Photos screens under a Photos-owned key;
  // it is one hook in `kit/band/band-owner.ts` now, on the same
  // `shell.bandOwner.<appId>` key the web shell already used, and the member's
  // answer is WRITTEN from frame Settings rather than only read.
  const { bandOwner } = useBandOwner("photos");

  const selecting = (selection?.count ?? 0) > 0;

  const onDestination = (key: BandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    // POP, never push. From a pushed screen the four shelf destinations all
    // live on the stack's home surface, so this returns there with the
    // destination named; tapping "Library" from inside an album must land on
    // the library, not deepen a stack the member then has to unwind. `navigate`
    // used to mean exactly that and no longer does — on React Navigation 7 it
    // pushes a second `PhotosHome` instead, which is the same defect the
    // capsule had. `PhotosHome` is this stack's initial route, so `popTo`
    // always finds it.
    navigation.popTo("PhotosHome", { destination: key });
  };

  const onMoreRow = (key: PhotosMoreRowKey): void => {
    setMoreOpen(false);
    // Cross-stack (B2) — Backup health lives in frame Settings now, and it is
    // the only row this sheet still carries (see `photos-band.ts`).
    const route = resolveMoreRowRoute(key);
    navigation.navigate(route.screen, route.params);
  };

  return (
    <View
      style={[
        styles.frame,
        // One page for the shell and every app in it (docs/traps/design-tokens.md).
        { backgroundColor: colors.bg, paddingTop: insets.top },
      ]}
    >
      {/* Content ends ABOVE the bar (§G) STRUCTURALLY: the slot is `flex:1`
          and the bar below it is `flex:none`, so the scroll viewport is
          genuinely shorter by the bar's height. This used to be an absolute
          bar plus a `paddingBottom` of the band's height on this slot, which
          only cleared the END of the content — mid-scroll it still ran
          underneath. Both bars apply the home-indicator inset themselves. */}
      <View style={styles.body}>{children}</View>

      {/* Exactly ONE bar at the foot. While a selection is live it is the
          selection bar; otherwise it is the band. Never both. */}
      {selecting && selection ? (
        // The selection bar carries the band's own 12pt bottom inset through
        // `bandSurfaceStyle`'s `marginBottom`; the home-indicator lift is the
        // one thing it cannot know, so it is added here — exactly once, and
        // only on this branch, since `PhotosBand` adds its own.
        <View style={{ paddingBottom: insets.bottom }}>
          <SelectionBottomBar selection={selection} />
        </View>
      ) : (
        <PhotosBand
          owner={bandOwner}
          current={current}
          onSelect={onDestination}
          // HOME, and `popTo` — see `PhotosHome.tsx`'s capsule for the whole
          // reasoning. `goBack()` is a no-op when Photos was entered by deep
          // link (`deep-links.ts` maps `photos` straight onto the cover), and
          // `navigate` pushes a SECOND Home over the cover on React
          // Navigation 7, which UIKit then presents as a card sheet.
          onHome={() => navigation.popTo("Home")}
        />
      )}

      <PhotosMoreSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
      />
    </View>
  );
}

/**
 * The bar that replaces the band (§6, proto:4946): five 56px targets where a
 * thumb is, each named under its mark. The count, Select all and Done stay in
 * the screen's own head on this surface — this bar is the actions only.
 */
function SelectionBottomBar({
  selection,
}: {
  selection: PhotosSelectionProps;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const actions = buildSelectionActions({
    count: selection.count,
    shelf: selection.shelf,
    copyLabel: selection.copyLabel,
    readOnlyReason: selection.readOnlyReason,
    favorite: selection.favorite,
    addToAlbum: selection.addToAlbum,
    share: selection.share,
    download: selection.download,
    trash: selection.trash,
  });
  const reason = selectionBarReason(actions);
  return (
    // The reason sits ABOVE the bar, not under it: the bar is anchored to the
    // foot of the stage, so a line below it would be off the bottom edge.
    <View>
      {reason ? (
        <Text style={[styles.selectionReason, { color: colors.net }]}>
          {reason}
        </Text>
      ) : null}
      <View style={styles.selectionBar} accessibilityRole="toolbar">
        {actions.map((action) => (
          <Pressable
            accessibilityLabel={action.label}
            accessibilityRole="button"
            accessibilityState={{ disabled: action.disabled }}
            // The hint still reaches a screen reader that lands directly on
            // the control; it is never the ONLY place the reason lives — the
            // visible line below is what a sighted member reads (§6, §18).
            accessibilityHint={action.disabled ? action.reason : undefined}
            disabled={action.disabled}
            key={action.id}
            // `buildSelectionActions` already replaced a disabled target's
            // handler with a no-op; this guard is the second half of the same
            // rule, so neither a synthetic press nor a future refactor of the
            // table alone can reach a write the member's grant refuses.
            onPress={() => {
              if (action.disabled) return;
              action.run();
            }}
            style={styles.selectionTarget}
          >
            <Icon
              name={action.icon}
              size={22}
              color={
                action.disabled
                  ? colors.textDisabled
                  : action.destructive
                    ? colors.net
                    : colors.text
              }
            />
            <Text
              numberOfLines={1}
              style={[
                styles.selectionLabel,
                {
                  color: action.disabled
                    ? colors.textDisabled
                    : action.destructive
                      ? colors.net
                      : colors.text,
                },
              ]}
            >
              {action.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // The content slot takes what is left after the head and the bar at the
    // foot. No absolute slot, and so nothing to reserve.
    body: { flex: 1 },
    frame: { flex: 1 },
    // The band's rectangle, exactly: the selection bar is the band's
    // replacement, so it is the same paper, the same inset and the same
    // radius rather than a second kind of bar at the foot.
    selectionBar: {
      alignItems: "center",
      flexDirection: "row",
      minHeight: SELECTION_ACTION_TARGET,
      paddingHorizontal: 4,
      ...bandSurfaceStyle(colors.bg, colors.line, BAND_BORDER),
    },
    selectionLabel: { ...t("control"), textAlign: "center" },
    selectionReason: {
      ...t("mono"),
      marginBottom: 6,
      marginHorizontal: BAND_INSET,
      textAlign: "center",
    },
    selectionTarget: {
      alignItems: "center",
      flex: 1,
      gap: 2,
      justifyContent: "center",
      minHeight: SELECTION_ACTION_TARGET,
      paddingVertical: 4,
    },
  });
