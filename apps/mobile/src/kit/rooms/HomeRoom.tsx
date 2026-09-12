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
  /**
   * The cover head's one trailing verb — Settings (D6). A cover that draws its
   * own title row passes `head` instead; the two are alternatives, and the
   * room never draws both.
   */
  trailing?: RoomAction;
  /**
   * The cover's own title row, when it carries a word as well as the verb.
   * Fixed chrome: it sits ABOVE the scroller, so the scrollbar starts under
   * the rule rather than beside the title.
   */
  head?: React.ReactNode;
  /** Which vault, which gateway — the same lockup every app draws. */
  vault?: React.ReactNode;
  /**
   * THE ONE STATUS LINE on the cover. Home is not covered by anything, so this
   * is the root host's line rendered in place rather than a second channel
   * (audit B5): the room states where it sits, and nothing else may.
   */
  status?: React.ReactNode;
  /** The app band, flush at the foot. */
  band?: React.ReactNode;
  /** The sheets the cover owns — all apps, the vault switcher, search. */
  overlay?: React.ReactNode;
  /** The arrival handle every end-to-end flow waits on. */
  testID?: string;
  loading?: RoomLoading;
  error?: RoomError;
  empty?: RoomEmpty;
  children?: React.ReactNode;
}

export default function HomeRoom({
  trailing,
  head,
  vault,
  status,
  band,
  overlay,
  testID,
  loading,
  error,
  empty,
  children,
}: HomeRoomProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ backgroundColor: colors.bg }), [colors]);
  return (
    <TopSafeArea style={[styles.room, ink]} testID={testID}>
      {vault}
      {head}
      {!head && trailing ? (
        <View style={styles.coverHead}>
          <Button
            disabled={trailing.disabled}
            label={trailing.label}
            onPress={() => trailing.onPress()}
            variant="quiet"
          />
        </View>
      ) : null}
      {status}
      <RoomBody empty={empty} error={error} loading={loading}>
        {children}
      </RoomBody>
      {band}
      {overlay}
    </TopSafeArea>
  );
}
