// THE FRAME EVERY PHOTOS SURFACE SITS IN — now one of the six rooms (#1015).
//
// It owns the lockup, the claimed band, the More sheet and, since Wave 2, the
// three things ten surfaces each owned separately: the header, the back
// affordance and the selection mode.
//
// THE BAND IS NOT AN EXIT (audit S2). Seven pushed surfaces said
// `more` as their band tab and then drew their own chevron, because the band lit a
// destination none of them was reached from. `PhotosBackControl` is deleted:
// `PushedPage` draws the back key, and it names the place the route actually
// descends from, computed in `photos-places.ts`.
//
// SELECTION IS A MODE (D5, audit B8). The old frame grew a second bar under a
// live band, so a tap aimed at "Delete" navigated away. The room swaps the
// header in place, dims the band through leaf tokens and stops it answering,
// and carries one action row at the foot. The verbs are still the shared
// selection engine's — this file only lowers them into the room's shape.

import { useNavigation } from "@react-navigation/native";
import React, { useState } from "react";

import {
  buildSelectionActions,
  selectionBarReason,
} from "@centraid/blueprints/apps/_shared/selection-engine";
import type {
  SelectionHandler,
  SelectionShelfKind,
} from "@centraid/blueprints/apps/_shared/selection-engine";

import { useBandOwner } from "../../kit/band/band-owner";
import { AppPlace, PushedPage } from "../../kit/rooms";
import type {
  BandState,
  RoomAction,
  RoomSelectionAction,
} from "../../kit/rooms";
import type { PhotosShellNavigation } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import { resolveMoreRowRoute } from "./photos-band";
import type { BandDestinationKey, PhotosMoreRowKey } from "./photos-band";
import { PHOTOS_META } from "./photos-meta";
import {
  isPhotosPlace,
  photosDestinationFor,
  photosParentPlace,
} from "./photos-places";
import type { PhotosRouteKey } from "./photos-places";
import PhotosBand from "./PhotosBand";
import PhotosMoreSheet from "./PhotosMoreSheet";

export interface PhotosSelectionProps {
  count: number;
  shelf: SelectionShelfKind;
  copyLabel: string;
  readOnlyReason: string | null;
  favorite: SelectionHandler;
  addToAlbum: SelectionHandler;
  share: SelectionHandler;
  download: SelectionHandler;
  trash: SelectionHandler;
  /** Leaving the mode. The room draws the word; this is what it does. */
  onCancel?: () => void;
}

export interface PhotosScreenProps {
  /** The route this surface IS: its band tab and the place it descends from
   *  are read off it. */
  route: PhotosRouteKey;
  /** The word in the header. A pushed page always carries one. */
  title: string;
  /** Leaving. The room draws the control. */
  onBack?: () => void;
  action?: RoomAction;
  children: React.ReactNode;
  selection?: PhotosSelectionProps;
}

/** The shared engine's verbs, lowered into the room's one action row. */
function engineActions(selection: PhotosSelectionProps) {
  return buildSelectionActions({
    addToAlbum: selection.addToAlbum,
    copyLabel: selection.copyLabel,
    count: selection.count,
    download: selection.download,
    favorite: selection.favorite,
    readOnlyReason: selection.readOnlyReason,
    share: selection.share,
    shelf: selection.shelf,
    trash: selection.trash,
  });
}

function selectionActions(
  selection: PhotosSelectionProps
): readonly RoomSelectionAction[] {
  return engineActions(selection).map((action) => ({
    dangerous: action.destructive,
    disabled: action.disabled,
    label: action.label,
    onPress: () => {
      if (action.disabled) return;
      action.run();
    },
  }));
}

export default function PhotosScreen({
  route,
  title,
  onBack,
  action,
  children,
  selection,
}: PhotosScreenProps): React.JSX.Element {
  const navigation = useNavigation<PhotosShellNavigation>();
  const [moreOpen, setMoreOpen] = useState(false);
  // The FRAME's latch, not Photos' (#712).
  const { bandOwner } = useBandOwner("photos");

  const onDestination = (key: BandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    // POP, never push: `navigate` pushes a second `PhotosHome` on RN7.
    navigation.popTo("PhotosHome", { destination: key });
  };

  const onMoreRow = (key: PhotosMoreRowKey): void => {
    setMoreOpen(false);
    const target = resolveMoreRowRoute(key);
    navigation.navigate(target.screen, target.params);
  };

  const room = selection
    ? {
        actions: selectionActions(selection),
        count: selection.count,
        // Never the ONLY place the reason lives: the unavailable verb carries
        // it as its own hint too (§6).
        note: selectionBarReason(engineActions(selection)) ?? undefined,
        noun: "photograph",
        onCancel: selection.onCancel ?? ((): void => undefined),
      }
    : undefined;

  const body = (
    <>
      {children}
      <PhotosMoreSheet
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
        visible={moreOpen}
      />
    </>
  );

  const band = (state: BandState): React.JSX.Element => (
    <PhotosBand
      destination={photosDestinationFor(route)}
      dimmed={state.dimmed}
      interactive={state.interactive}
      onHome={() => navigation.popTo("Home")}
      onSelect={onDestination}
      owner={bandOwner}
    />
  );

  // The vault lockup on every route (see `VaultBar`): which vault, which
  // gateway, and the product's two global verbs.
  const lockup = <VaultBar />;
  const leave = onBack ?? ((): void => navigation.popTo("Home"));

  if (isPhotosPlace(route))
    return (
      <AppPlace
        action={action}
        app={{ color: PHOTOS_META.color, iconKey: PHOTOS_META.iconKey, title }}
        band={band}
        lockup={lockup}
        onBack={leave}
        selection={room}
      >
        {body}
      </AppPlace>
    );

  return (
    <PushedPage
      action={action}
      backTo={photosParentPlace(route)}
      band={band}
      lockup={lockup}
      onBack={leave}
      selection={room}
      title={title}
    >
      {body}
    </PushedPage>
  );
}
