// SELECTION AS A MODE (#1015, D5 — audit B8).
//
// The header swaps IN PLACE: no second bar appears, because a bar that
// appears pushes the content the member is selecting from. The count is the
// title, "Cancel" is the only way out, and the verbs live in ONE row at the
// foot — which is why the band must be dim and deaf while this is up.

import React, { useMemo } from "react";
import { View } from "react-native";

import Button from "../components/Button";
import { Text } from "../components/NativeText";
import { useTheme } from "../theme";
import { selectedSentence } from "./room-contracts";
import type { RoomSelection } from "./room-contracts";
import { styles } from "./rooms.styles";

export function SelectionHeader({
  selection,
}: {
  selection: RoomSelection;
}): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      bar: { borderBottomColor: colors.line },
      text: { color: colors.text },
    }),
    [colors]
  );
  return (
    <View style={[styles.bar, ink.bar]}>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={[styles.barTitle, ink.text]}
      >
        {selectedSentence(selection)}
      </Text>
      <Button
        label="Cancel"
        onPress={() => selection.onCancel()}
        variant="quiet"
      />
    </View>
  );
}

export function SelectionActions({
  selection,
}: {
  selection: RoomSelection;
}): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(
    () => ({
      foot: { borderTopColor: colors.line },
      note: { color: colors.net },
    }),
    [colors]
  );
  return (
    <View style={[styles.foot, ink.foot]}>
      {selection.note ? (
        <Text style={[styles.selectionNote, ink.note]}>{selection.note}</Text>
      ) : null}
      <View style={styles.actionRow}>
        {selection.actions.map((action) => (
          <Button
            disabled={action.disabled}
            key={action.label}
            label={action.label}
            onPress={() => action.onPress()}
            // Outlined `--net`, never filled: the destructive verb still has
            // a confirm behind it (S7), so it is not the view's one commit.
            variant={action.dangerous === true ? "destructive" : "secondary"}
          />
        ))}
      </View>
    </View>
  );
}
