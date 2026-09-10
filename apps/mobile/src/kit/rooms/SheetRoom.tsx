// SHEET (#1015, S1; D4): choices sheet, content pushes.
//
// `OptionSheet` is the single-CHOICE list and stays what it is; on iOS it is
// `ActionSheetIOS`, which draws system rows and can carry neither an outlined
// `--net` verb nor a hosted status line. So the room a sheet with its own
// anatomy needs — grabber, a title carrying the noun, at most one primary ink
// button — is this one, and `ConfirmSheet` is built on it (S7).
//
// The status line is hosted inside for the same reason the editor hosts one:
// a sheet is a `Modal`, and a note posted from inside it would otherwise
// paint under it (audit B5).

import React, { useMemo } from "react";
import { Modal, Pressable, View } from "react-native";

import Button from "../components/Button";
import Grabber from "../components/Grabber";
import { Text } from "../components/NativeText";
import StatusLineHost from "../components/StatusLineHost";
import { useTheme } from "../theme";
import type { RoomAction } from "./room-contracts";
import { styles } from "./rooms.styles";

export interface SheetRoomProps {
  visible: boolean;
  /** The words, with the noun in them ("Delete 3 photos?"). */
  title: string;
  onClose: () => void;
  /** At most one ink commit; a destructive one is outlined, not filled. */
  primary?: RoomAction & { dangerous?: boolean };
  /** The quiet way out; "Cancel" unless the caller has a truer word. */
  cancelLabel?: string;
  children?: React.ReactNode;
  /** A confirm this sheet raises over itself; a sibling, never a child. */
  overlay?: React.ReactNode;
  /** For the end-to-end flows that name a sheet by id, not by its title. */
  testID?: string;
}

export default function SheetRoom({
  visible,
  title,
  onClose,
  primary,
  cancelLabel,
  children,
  overlay,
  testID,
}: SheetRoomProps): React.JSX.Element | null {
  const leave = cancelLabel ?? "Cancel";
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      scrim: { backgroundColor: colors.scrim },
      sheet: { backgroundColor: colors.bgElev, borderColor: colors.line },
      title: { color: colors.text },
    }),
    [colors]
  );
  if (!visible) return null;
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible>
      <Pressable
        accessibilityLabel="Dismiss"
        onPress={onClose}
        style={[styles.scrim, ink.scrim]}
      />
      <View style={[styles.sheet, ink.sheet]} testID={testID}>
        <Grabber />
        <Text accessibilityRole="header" style={[styles.sheetTitle, ink.title]}>
          {title}
        </Text>
        <View style={styles.sheetBody}>{children}</View>
        <View style={styles.actionRow}>
          <Button label={leave} onPress={onClose} variant="quiet" />
          {primary ? (
            <Button
              disabled={primary.disabled}
              label={primary.label}
              onPress={() => primary.onPress()}
              variant={primary.dangerous === true ? "destructive" : "primary"}
            />
          ) : null}
        </View>
        <StatusLineHost name="sheet" />
      </View>
      {overlay}
    </Modal>
  );
}
