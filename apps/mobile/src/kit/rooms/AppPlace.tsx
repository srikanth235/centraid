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
  /** At most one, per DESIGN.md's one-primary rule. */
  action?: RoomAction;
  /**
   * The frame's own lockup (`VaultBar`) above the app's header: which vault,
   * which gateway, and the product's two global verbs. It belongs to the
   * frame rather than to the room, so it arrives as a node — but it must sit
   * INSIDE the room's safe area, or the app draws its own inset and the two
   * disagree by the status bar's height (Tally, Locker, People, Photos all
   * had their own `paddingTop: insets.top` before #1015 Wave 2).
   */
  lockup?: React.ReactNode;
  search?: SearchFieldProps;
  selection?: RoomSelection;
  /** The app's own band, told what state the room puts it in. */
  band?: (state: BandState) => React.ReactNode;
  loading?: RoomLoading;
  error?: RoomError;
  empty?: RoomEmpty;
  children?: React.ReactNode;
}

export default function AppPlace({
  app,
  onBack,
  action,
  lockup,
  search,
  selection,
  band,
  loading,
  error,
  empty,
  children,
}: AppPlaceProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ backgroundColor: colors.bg }), [colors]);
  const bandState = bandStateFor(selection);
  const selecting = !bandState.interactive;
  return (
    <TopSafeArea style={[styles.room, ink]}>
      {lockup}
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
              variant="secondary"
            />
          ) : null}
        </View>
      )}
      {search && !selecting ? <SearchField {...search} /> : null}
      <RoomBody empty={empty} error={error} loading={loading}>
        {children}
      </RoomBody>
      {selecting && selection ? (
        <SelectionActions selection={selection} />
      ) : null}
      {band?.(bandState)}
    </TopSafeArea>
  );
}
