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
  /** Frame chrome above the back row — see `AppPlaceProps.chrome`. */
  chrome?: React.ReactNode;
  /** At most one filled commit, per DESIGN.md. */
  action?: RoomAction;
  secondary?: RoomAction;
  search?: SearchFieldProps;
  /**
   * The controls that pick WHICH content the body is showing — a day stepper,
   * a lens and sort row. They sit under the search and ABOVE the body, and
   * outside it: the body is a state machine, and a stepper that vanished on
   * the empty day would be a control the member cannot use to leave that day
   * (Agenda needed this first, #1015 audit agenda/findings#3).
   */
  toolbar?: React.ReactNode;
  selection?: RoomSelection;
  band?: (state: BandState) => React.ReactNode;
  /**
   * Presentations this screen owns: a confirm sheet, an editor that is state
   * rather than a route. They mount OUTSIDE `RoomBody`, because the body is a
   * state machine — an empty state replaces the children — and an editor that
   * unmounted the moment its list went empty would be a room deciding
   * something no screen asked it to.
   */
  overlay?: React.ReactNode;
  loading?: RoomLoading;
  error?: RoomError;
  empty?: RoomEmpty;
  children?: React.ReactNode;
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
  chrome,
  action,
  secondary,
  search,
  selection,
  toolbar,
  band,
  loading,
  error,
  empty,
  overlay,
  children,
}: PushedPageProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ backgroundColor: colors.bg }), [colors]);
  const bandState = bandStateFor(selection);
  const selecting = !bandState.interactive;
  return (
    <TopSafeArea style={[styles.room, ink]}>
      {chrome}
      {selecting && selection ? (
        <SelectionHeader selection={selection} />
      ) : (
        <>
          {backTo ? <BackKey backTo={backTo} onBack={onBack} /> : null}
          <PlaceHeader
            primary={
              action
                ? {
                    label: action.label,
                    onPress: action.onPress,
                    testID: action.testID,
                  }
                : undefined
            }
            secondary={
              secondary
                ? {
                    label: secondary.label,
                    onPress: secondary.onPress,
                    testID: secondary.testID,
                  }
                : undefined
            }
            title={title}
          />
        </>
      )}
      {search && !selecting ? <SearchField {...search} /> : null}
      {selecting ? null : toolbar}
      <RoomBody empty={empty} error={error} loading={loading}>
        {children}
      </RoomBody>
      {overlay}
      {selecting && selection ? (
        <SelectionActions selection={selection} />
      ) : null}
      <View>{band?.(bandState)}</View>
    </TopSafeArea>
  );
}
