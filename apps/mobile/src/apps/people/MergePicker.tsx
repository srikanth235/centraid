// The "merge this person into…" sheet.
//
// Its own presentation, not a block inside People's detail column. Listed
// inline it mounted one Pressable per person — up to the whole 5,000-row
// directory — because a ScrollView has no windowing, and a same-direction
// FlatList nested in one renders everything anyway. As a sheet it owns its
// scroll axis, so it can window, and the search field keeps the candidate set
// small enough to read.

import { Feather } from "@expo/vector-icons";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ListRenderItemInfo } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { useTheme } from "../../kit/theme";
import { mergeCandidates } from "./merge-candidates";
import { styles } from "./PeopleHome.styles";
import {
  keyOfPerson,
  PEOPLE_MERGE_LIST_ID,
  personItemLayout,
  PersonListRow,
} from "./PersonListRow";
import type { PersonRow } from "./PersonListRow";

export function MergePicker({
  visible,
  people,
  keepingName,
  excludePartyId,
  colors,
  onClose,
  onPick,
}: {
  visible: boolean;
  people: readonly PersonRow[];
  /** Whoever is being folded away; absent when nobody is selected. */
  keepingName?: string;
  excludePartyId?: string;
  colors: ReturnType<typeof useTheme>["colors"];
  onClose: () => void;
  onPick: (target: PersonRow) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const choices = useMemo(
    () => mergeCandidates(people, excludePartyId, query),
    [excludePartyId, people, query]
  );
  // `onPick` closes over the screen's write path and is rebuilt every render.
  // Taking it as a dependency would give every candidate row a fresh `onSelect`
  // and defeat `PersonListRow`'s memo, so the rows call the latest one here.
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  });
  const renderCandidate = useCallback(
    ({ item, index }: ListRenderItemInfo<PersonRow>) => (
      <PersonListRow
        testID={`${PEOPLE_MERGE_LIST_ID}-row-${index}`}
        person={item}
        selected={false}
        colors={colors}
        onSelect={() => pick.current(item)}
      />
    ),
    [colors]
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.detailTitle, { color: colors.text }]}>
              Merge into…
            </Text>
            <Text style={[styles.meta, { color: colors.textSoft }]}>
              {keepingName
                ? `${keepingName} is folded into whoever you pick.`
                : "Pick the person to keep."}
            </Text>
          </View>
          <Pressable accessibilityLabel="Cancel merge" onPress={onClose}>
            <Feather name="x" size={24} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.mergeSearch}>
          <TextInput
            placeholder="Search people"
            placeholderTextColor={colors.textFaint}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            style={[
              styles.input,
              { borderColor: colors.line, color: colors.text },
            ]}
          />
        </View>
        <FlatList
          testID={PEOPLE_MERGE_LIST_ID}
          accessibilityLabel="Merge candidates"
          data={choices}
          keyExtractor={keyOfPerson}
          renderItem={renderCandidate}
          getItemLayout={personItemLayout}
          initialNumToRender={16}
          maxToRenderPerBatch={12}
          windowSize={5}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={[styles.mergeEmpty, { color: colors.textSoft }]}>
              Nobody matches that name.
            </Text>
          }
        />
      </SafeAreaView>
    </Modal>
  );
}
