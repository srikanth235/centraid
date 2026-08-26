// SEARCH — `locker/search` (README-Locker §6, "Search note").
//
// TITLE, USERNAME AND ADDRESS ONLY, AND IT SAYS SO. The §6 sentence is
// verbatim on the screen, not in a help panel: a note routinely holds recovery
// codes, so it is excluded BY DESIGN rather than by omission, and a member who
// searches for one and finds nothing has to be told which of those two it was.
//
// The matching happens server-side over fields the payload never returns, and
// the results are the same secret-free row the list draws.

import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  SEARCH_MATCHED,
  SEARCH_PLACEHOLDER,
  SEARCH_RESULTS,
} from "@centraid/blueprints/apps/locker/route-copy";
import type { LockerRow as LockerRowData } from "@centraid/blueprints/apps/locker/types";
import { SEARCH_NOTE } from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import { Text, TextInput } from "../../kit/components/NativeText";
import SectionBlock from "../../kit/components/SectionBlock";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { LockerRow, lockerRowKey } from "./LockerRow";

export interface LockerSearchViewProps {
  term: string;
  /** `null` until a search has run — resting and "no match" are two states. */
  results: readonly LockerRowData[] | null;
  onSearch: (term: string) => void;
  onOpen: (row: LockerRowData) => void;
}

export default function LockerSearchView(
  props: LockerSearchViewProps
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [term, setTerm] = useState(props.term);
  const results = props.results;

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.field}>
        <TextInput
          accessibilityLabel={SEARCH_PLACEHOLDER}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setTerm}
          onSubmitEditing={() => props.onSearch(term)}
          placeholder={SEARCH_PLACEHOLDER}
          placeholderTextColor={colors.textFaint}
          returnKeyType="search"
          style={styles.input}
          value={term}
        />
        <Button label="Search" onPress={() => props.onSearch(term)} />
      </View>

      {/* §6, verbatim. It sits above the results, not under them: a member
          who found nothing should already know what was not looked at. */}
      <Text style={styles.note}>{SEARCH_NOTE}</Text>

      {results === null ? null : (
        <View>
          <SectionBlock
            label={SEARCH_RESULTS}
            meta={`${String(results.length)} ${SEARCH_MATCHED}`}
          />
          {results.map((row) => (
            <LockerRow
              key={lockerRowKey(row)}
              row={row}
              onOpen={props.onOpen}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    field: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      padding: spacing[4],
    },
    input: {
      ...t("body"),
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      flex: 1,
      minHeight: 44,
      paddingHorizontal: spacing[3],
    },
    note: {
      ...t("mono"),
      color: colors.textFaint,
      paddingBottom: spacing[3],
      paddingHorizontal: spacing[4],
    },
    scroll: { paddingBottom: spacing[6] },
  });
