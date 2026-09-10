// PUSHED PAGE (#1015, S1 — audit B7): an album, a contact, a document, a
// settings sub-page. `PlaceHeader`, a back control naming the parent it
// actually descends from, at most one trailing action.
//
// `backTo` is a `PlaceRef`, not a string: thirteen Docs screens said
// `backTo="All"` and twelve of them were lying, in the visible label and in
// the VoiceOver word alike. A `PlaceRef` can only be computed (`place.ts`).

import React, { useMemo } from "react";
import { Pressable, View } from "react-native";

import Icon from "../components/Icon";
import { Text } from "../components/NativeText";
import PlaceHeader from "../components/PlaceHeader";
import SearchField from "../components/SearchField";
import type { SearchFieldProps } from "../components/SearchField";
import TopSafeArea from "../components/TopSafeArea";
import { t, useTheme } from "../theme";
import type { PlaceRef } from "./place";
import { bandStateFor } from "./room-contracts";
import type {
  BandState,
  RoomAction,
  RoomEmpty,
  RoomError,
  RoomLoading,
  RoomSelection,
} from "./room-contracts";
import RoomBody from "./RoomBody";
import { styles } from "./rooms.styles";
import { SelectionActions, SelectionHeader } from "./SelectionBars";

export interface PushedPageProps {
  title: string;
  /** Computed from the stack (`parentPlace`), never written down. */
  backTo?: PlaceRef;
  onBack: () => void;
  /** At most one filled commit, per DESIGN.md. */
  action?: RoomAction;
  secondary?: RoomAction;
  /** The frame's lockup above the back key; see `AppPlaceProps.lockup`. */
  lockup?: React.ReactNode;
  search?: SearchFieldProps;
  selection?: RoomSelection;
  band?: (state: BandState) => React.ReactNode;
  loading?: RoomLoading;
  error?: RoomError;
  empty?: RoomEmpty;
  children?: React.ReactNode;
  /**
   * The docked strip under the body — Assistant's composer, a health line.
   * A SIBLING of the body, not the last row inside it, so it stays put while
   * the body scrolls and the room keeps owning the page's vertical order.
   */
  footer?: React.ReactNode;
  /** The modals this page owns; siblings of the body, never inside it. */
  overlay?: React.ReactNode;
  /** For the end-to-end flows that name a page by id, not by its title. */
  testID?: string;
}

/** The back control: a chevron and the parent's real name, spoken together. */
export function BackKey({
  backTo,
  onBack,
}: {
  backTo: PlaceRef;
  onBack: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ color: colors.text }), [colors]);
  return (
    <Pressable
      accessibilityLabel={`Back to ${backTo.title}`}
      accessibilityRole="button"
      hitSlop={12}
      onPress={onBack}
      style={styles.backRow}
    >
      <Icon color={colors.text} name="ArrowLeft" size={20} />
      <Text numberOfLines={1} style={[t("control"), ink]}>
        {backTo.title}
      </Text>
    </Pressable>
  );
}

export default function PushedPage({
  title,
  backTo,
  onBack,
  action,
  secondary,
  lockup,
  search,
  selection,
  band,
  loading,
  error,
  empty,
  children,
  footer,
  overlay,
  testID,
}: PushedPageProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ backgroundColor: colors.bg }), [colors]);
  const bandState = bandStateFor(selection);
  const selecting = !bandState.interactive;
  return (
    <TopSafeArea style={[styles.room, ink]} testID={testID}>
      {lockup}
      {selecting && selection ? (
        <SelectionHeader selection={selection} />
      ) : (
        <>
          {backTo ? <BackKey backTo={backTo} onBack={onBack} /> : null}
          <PlaceHeader
            primary={
              action
                ? { label: action.label, onPress: action.onPress }
                : undefined
            }
            secondary={
              secondary
                ? { label: secondary.label, onPress: secondary.onPress }
                : undefined
            }
            title={title}
          />
        </>
      )}
      {search && !selecting ? <SearchField {...search} /> : null}
      <RoomBody empty={empty} error={error} loading={loading}>
        {children}
      </RoomBody>
      {footer}
      {selecting && selection ? (
        <SelectionActions selection={selection} />
      ) : null}
      <View>{band?.(bandState)}</View>
      {overlay}
    </TopSafeArea>
  );
}
