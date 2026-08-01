// One row of the People directory, and the geometry the list places it with.
//
// Extracted so the screen file is the directory's data and writes while this is
// its cell. The height constant and `getItemLayout` live here beside the row
// they describe — they are only correct together, and splitting them is how a
// list starts placing rows at the wrong offsets.

import React, { memo } from "react";
import { Pressable, Text } from "react-native";

import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";

import type { useTheme } from "../../kit/theme";
import { styles } from "./PeopleHome.styles";

export type PersonRow = ReplicaRow & {
  party_id: string;
  name: string;
  role?: ReplicaValue;
};

/**
 * Fixed by construction: 13pt padding top and bottom, a 18pt name line, a 15pt
 * role line and the 1pt divider. Both lines are clamped to one line so no name
 * can wrap and break the arithmetic `getItemLayout` depends on.
 */
export const PERSON_ROW_HEIGHT = 60;

/**
 * Machine handles for the #659 scroll probe
 * (tests/agent-e2e-mobile/flows/scroll-frames.mjs), which could not target this
 * screen at all: everything People published was either a tab-bar route name —
 * drawn on every screen, and banned by scripts/lint-e2e-flows.mjs precisely
 * because asserting it proves nothing — or seeded content that changes with the
 * fixture. `testID` is the right tool rather than another `accessibilityLabel`:
 * it maps to Maestro's `id:` selector on both platforms and, unlike a label, a
 * screen reader never reads it out. The container keeps a real
 * `accessibilityLabel` too, because "People directory" is genuinely what it is.
 */
export const PEOPLE_LIST_ID = "people-directory";
export const PEOPLE_MERGE_LIST_ID = "people-merge-directory";

export const keyOfPerson = (person: PersonRow): string =>
  String(person.party_id);

export const personItemLayout = (
  _data: ArrayLike<PersonRow> | null | undefined,
  index: number
): { length: number; offset: number; index: number } => ({
  length: PERSON_ROW_HEIGHT,
  offset: PERSON_ROW_HEIGHT * index,
  index,
});

/**
 * One directory row. Memoized so selecting a person re-renders the two rows
 * whose highlight actually changed rather than every mounted row.
 */
export const PersonListRow = memo(
  ({
    person,
    selected,
    colors,
    onSelect,
    testID,
  }: {
    person: PersonRow;
    selected: boolean;
    colors: ReturnType<typeof useTheme>["colors"];
    onSelect: (partyId: string) => void;
    testID: string;
  }) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => onSelect(String(person.party_id))}
      style={[
        styles.person,
        {
          backgroundColor: selected ? colors.bgSunken : colors.bg,
          borderColor: colors.line,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[styles.personName, { color: colors.text }]}
      >
        {String(person.name)}
      </Text>
      <Text
        numberOfLines={1}
        style={[styles.meta, { color: colors.textFaint }]}
      >
        {String(person.role ?? "No role")}
      </Text>
    </Pressable>
  )
);

PersonListRow.displayName = "PersonListRow";
