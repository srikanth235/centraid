// HOME (#1015, S1). The cover grid of app marks, one status line, and no
// floating key — home is where the key would take you.
//
// The trailing control is the ONE thing the cover head carries, and per D6 it
// is Settings: the stem foot has to be reachable from the springboard, not
// only from a More sheet three taps in (audit B15).
//
// The status line is the ROOT host `App.tsx` already mounts; Home does not
// claim one, because nothing covers the app root here.

import React, { useMemo } from "react";
import { View } from "react-native";

import Button from "../components/Button";
import TopSafeArea from "../components/TopSafeArea";
import { useTheme } from "../theme";
import type {
  RoomAction,
  RoomEmpty,
  RoomError,
  RoomLoading,
} from "./room-contracts";
import RoomBody from "./RoomBody";
import { styles } from "./rooms.styles";

export interface HomeRoomProps {
  /** The cover head's one trailing verb — Settings (D6). */
  trailing?: RoomAction;
  loading?: RoomLoading;
  error?: RoomError;
  empty?: RoomEmpty;
  children?: React.ReactNode;
}

export default function HomeRoom({
  trailing,
  loading,
  error,
  empty,
  children,
}: HomeRoomProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ backgroundColor: colors.bg }), [colors]);
  return (
    <TopSafeArea style={[styles.room, ink]}>
      {trailing ? (
        <View style={styles.coverHead}>
          <Button
            disabled={trailing.disabled}
            label={trailing.label}
            onPress={() => trailing.onPress()}
            variant="quiet"
          />
        </View>
      ) : null}
      <RoomBody empty={empty} error={error} loading={loading}>
        {children}
      </RoomBody>
    </TopSafeArea>
  );
}
