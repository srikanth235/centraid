// APP PLACE (#1015, S1): an app's own top surface — Photos grid, Tasks list,
// Tally ledger. `AppHeader` (mark + name + at most one trailing action), an
// optional search field under it, then the body.
//
// The band is the app's, not the room's — each app ships its own — so it
// arrives as a render prop and the room hands it the two facts it may not
// decide for itself: whether it is dimmed and whether it answers taps (D5).

import React, { useMemo } from "react";
import { View } from "react-native";

import AppHeader from "../components/AppHeader";
import Button from "../components/Button";
import SearchField from "../components/SearchField";
import type { SearchFieldProps } from "../components/SearchField";
import TopSafeArea from "../components/TopSafeArea";
import { useTheme } from "../theme";
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

export interface AppPlaceProps {
  /** Everything the header needs to draw the app's identity. */
  app: {
    title: string;
    subtitle?: string;
    color: string;
    iconKey: Parameters<typeof AppHeader>[0]["iconKey"];
  };
  /** Leaves the app, back to the springboard. */
  onBack: () => void;
  /**
   * Frame chrome above the header, on every route of the app: which vault and
   * which gateway (`VaultBar`). The room takes it as a node rather than
   * importing it, because the vault lockup lives in the shell's tree and a
   * room that reached for it would drag the launcher catalog into the kit —
   * the constraint `VaultBar` states about itself. NotesHome needed this
   * first (#1015, Wave 2).
   */
  chrome?: React.ReactNode;
  /** At most one, per DESIGN.md's one-primary rule. */
  action?: RoomAction;
  search?: SearchFieldProps;
  selection?: RoomSelection;
  /** The app's own band, told what state the room puts it in. */
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

export default function AppPlace({
  app,
  onBack,
  chrome,
  action,
  search,
  selection,
  band,
  loading,
  error,
  empty,
  overlay,
  children,
}: AppPlaceProps): React.JSX.Element {
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
        <View style={styles.headTrailing}>
          <View style={styles.body}>
            <AppHeader
              color={app.color}
              iconKey={app.iconKey}
              onBack={onBack}
              subtitle={app.subtitle}
              title={app.title}
            />
          </View>
          {action ? (
            <Button
              disabled={action.disabled}
              label={action.label}
              onPress={() => action.onPress()}
              testID={action.testID}
              variant="secondary"
            />
          ) : null}
        </View>
      )}
      {search && !selecting ? <SearchField {...search} /> : null}
      <RoomBody empty={empty} error={error} loading={loading}>
        {children}
      </RoomBody>
      {overlay}
      {selecting && selection ? (
        <SelectionActions selection={selection} />
      ) : null}
      {band?.(bandState)}
    </TopSafeArea>
  );
}
