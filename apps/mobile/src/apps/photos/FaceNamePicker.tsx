/*
 * THE NAMING PICKER (#1014, R12).
 *
 * It listed every `core_party` row, and each enrichment recipe enrols as one —
 * so naming a face offered "Document text", "Face recognition", "Image
 * embeddings", "Photo OCR", "Place names", "Text embeddings" and "Transcript"
 * beside the owner, and on a fresh library Owner was the only real choice it
 * had. The filter is `nameableParties`; the way OUT of that dead end is the
 * "New person…" field here.
 *
 * Its own file rather than more of `FaceReview.tsx`: that screen is at the
 * repo's 625-line ceiling.
 */

import React from "react";
import { Pressable, View } from "react-native";

import { Text, TextInput } from "../../kit/components/NativeText";
import type { ThemeColors } from "../../kit/theme";
import type { NameableParty } from "./face-review-model";
import { styles } from "./FaceReview.styles";

export interface FaceNamePickerProps {
  busy: boolean;
  colors: ThemeColors;
  /** Already excludes agents; the proposal's own party is filtered here. */
  people: readonly NameableParty[];
  proposedPartyId?: string | undefined;
  newName: string;
  onNewNameChange: (value: string) => void;
  onAddNewPerson: () => void;
  onPick: (partyId: string, name: string) => void;
}

export default function FaceNamePicker({
  busy,
  colors,
  people,
  proposedPartyId,
  newName,
  onNewNameChange,
  onAddNewPerson,
  onPick,
}: FaceNamePickerProps): React.JSX.Element {
  const trimmed = newName.trim();
  return (
    <View style={styles.picker}>
      <TextInput
        accessibilityLabel="New person's name"
        editable={!busy}
        onChangeText={onNewNameChange}
        onSubmitEditing={onAddNewPerson}
        placeholder="New person…"
        placeholderTextColor={colors.textFaint}
        returnKeyType="done"
        style={[
          styles.action,
          { borderColor: colors.line, color: colors.text },
        ]}
        value={newName}
      />
      {trimmed.length > 0 ? (
        <Pressable
          accessibilityLabel={`Add ${trimmed} and name this face`}
          accessibilityRole="button"
          disabled={busy}
          onPress={onAddNewPerson}
          style={[styles.action, { borderColor: colors.line }]}
        >
          <Text style={[styles.actionText, { color: colors.accentText }]}>
            Add “{trimmed}”
          </Text>
        </Pressable>
      ) : null}
      {people
        .filter((person) => person.partyId !== proposedPartyId)
        .map((person) => (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            key={person.partyId}
            onPress={() => onPick(person.partyId, person.name)}
            style={[styles.action, { borderColor: colors.line }]}
          >
            <Text style={[styles.actionText, { color: colors.text }]}>
              {person.name}
            </Text>
          </Pressable>
        ))}
    </View>
  );
}
