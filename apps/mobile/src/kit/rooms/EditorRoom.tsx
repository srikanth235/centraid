// EDITOR (#1015, S1; D3, D5, S3): a note, a doc, an expense, an event.
//
// Three things this room settles that every editor had settled differently:
//  - CLOSE MEANS DONE. Autosave is the writer's, but the exit word is not a
//    decision: it is "Done", and there is no Cancel once a key has been
//    pressed. `cancellable` is the pre-first-keystroke case, and only that.
//  - THE BAND IS HIDDEN. Not dimmed — an editor is not a place you navigate
//    away from sideways, and a live band under a keyboard is two bars (D5).
//    The leave key rides in the editor's own bar, which is why this room
//    takes no `band` prop at all (R-KIT-2).
//  - THE STATUS LINE IS HOSTED HERE. Every editor on this seat is an iOS
//    `Modal`, which renders above the app root, so a note posted from inside
//    one painted underneath it and was never seen (audit B5). One channel,
//    hosted where it can be read.

import React, { useMemo } from "react";
import { View } from "react-native";

import Button from "../components/Button";
import { Text } from "../components/NativeText";
import StatusLineHost from "../components/StatusLineHost";
import TopSafeArea from "../components/TopSafeArea";
import { useTheme } from "../theme";
import type { RoomError, RoomLoading } from "./room-contracts";
import RoomBody from "./RoomBody";
import { styles } from "./rooms.styles";

export interface EditorRoomProps {
  title: string;
  /** Leaving. Autosave has already run; this only dismisses. */
  onDone: () => void;
  /**
   * True only before the first keystroke, where discarding costs nothing and
   * "Cancel" is honest. After it, the word is "Done" and there is no discard.
   */
  cancellable?: boolean;
  loading?: RoomLoading;
  error?: RoomError;
  children?: React.ReactNode;
}

export default function EditorRoom({
  title,
  onDone,
  cancellable = false,
  loading,
  error,
  children,
}: EditorRoomProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      bar: { borderBottomColor: colors.line },
      room: { backgroundColor: colors.bg },
      title: { color: colors.text },
    }),
    [colors]
  );
  return (
    <TopSafeArea style={[styles.room, ink.room]}>
      <View style={[styles.bar, ink.bar]}>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={[styles.barTitle, ink.title]}
        >
          {title}
        </Text>
        <Button
          label={cancellable ? "Cancel" : "Done"}
          onPress={() => onDone()}
          variant={cancellable ? "quiet" : "primary"}
        />
      </View>
      <RoomBody error={error} loading={loading}>
        {children}
      </RoomBody>
      <StatusLineHost name="editor" />
    </TopSafeArea>
  );
}
