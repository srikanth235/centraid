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
import { Modal, View } from "react-native";

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
  /**
   * The acts that belong to the thing being edited — version history, delete,
   * restore, pin. One row at the foot, never a second header: the bar above
   * carries the title and the leave key and nothing else.
   */
  foot?: React.ReactNode;
  /**
   * An editor that is STATE rather than a route presents itself (NoteEditor,
   * DocumentEditor). `false` — the default — is the route case, where the
   * navigator has already presented the screen.
   *
   * Presented or not, the room hosts the status line: that is the whole point
   * of the host stack (audit B5), and a `Modal` is exactly the presentation
   * that swallowed the line before it.
   */
  presented?: boolean;
  /** Only read when `presented`: the editor is up. */
  visible?: boolean;
  /** The leave key's handle, from `kit/test-ids` — an end-to-end flow closes
   *  an editor by it (`notes-editor-close`). */
  leaveTestID?: string;
  children?: React.ReactNode;
}

export default function EditorRoom({
  title,
  onDone,
  cancellable = false,
  loading,
  error,
  foot,
  presented = false,
  visible = true,
  leaveTestID,
  children,
}: EditorRoomProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      bar: { borderBottomColor: colors.line },
      foot: { borderTopColor: colors.line },
      room: { backgroundColor: colors.bg },
      title: { color: colors.text },
    }),
    [colors]
  );
  if (presented && !visible) return null;
  const room = (
    <TopSafeArea
      accessibilityViewIsModal={presented}
      style={[styles.room, ink.room]}
    >
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
          testID={leaveTestID}
          variant={cancellable ? "quiet" : "primary"}
        />
      </View>
      <RoomBody error={error} loading={loading}>
        {children}
      </RoomBody>
      {foot ? (
        <View style={[styles.foot, ink.foot]}>
          <View style={styles.actionRow}>{foot}</View>
        </View>
      ) : null}
      <StatusLineHost name="editor" />
    </TopSafeArea>
  );
  if (!presented) return room;
  return (
    <Modal
      animationType="slide"
      onRequestClose={onDone}
      presentationStyle="pageSheet"
      visible
    >
      {room}
    </Modal>
  );
}
