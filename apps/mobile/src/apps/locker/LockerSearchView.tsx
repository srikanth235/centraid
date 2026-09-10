// SEARCH — `locker/search` (README-Locker §6, "Search note").
//
// TITLE, USERNAME AND ADDRESS ONLY, AND IT SAYS SO. The §6 sentence is
// verbatim on the screen, not in a help panel: a note routinely holds recovery
// codes, so it is excluded BY DESIGN rather than by omission, and a member who
// searches for one and finds nothing has to be told which of those two it was.
//
// The matching happens server-side over fields the payload never returns, and
// the results are the same secret-free row the list draws.
//
// WINDOWED (#883 C4): two letters can match it all.

import React, { useMemo, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";

import {
  SEARCH_MATCHED,
  SEARCH_NO_MATCH,
  SEARCH_NO_MATCH_BODY,
  SEARCH_PLACEHOLDER,
  SEARCH_RESULTS,
} from "@centraid/blueprints/apps/locker/route-copy";
import type { LockerRow as LockerRowData } from "@centraid/blueprints/apps/locker/types";
import { SEARCH_NOTE } from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import EmptyBlock from "../../kit/components/EmptyBlock";
import { Text } from "../../kit/components/NativeText";
import SearchField from "../../kit/components/SearchField";
import SectionBlock from "../../kit/components/SectionBlock";
import { pageMargin, spacing, t, useTheme } from "../../kit/theme";
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

  const renderItem = ({
    item,
  }: ListRenderItemInfo<LockerRowData>): React.JSX.Element => (
    <LockerRow row={item} onOpen={props.onOpen} />
  );

  const head = (
    <View>
      <SearchField
        onChangeText={setTerm}
        onSubmit={props.onSearch}
        placeholder={SEARCH_PLACEHOLDER}
        value={term}
      />
      {/* Locker searches on a VERB, not as it types: the matching happens
          server-side over fields the payload never returns, so every
          keystroke would be a round trip. The return key and this button are
          the same act. */}
      <View style={styles.verbRow}>
        <Button label="Search" onPress={() => props.onSearch(term)} />
      </View>

      {/* §6, verbatim. It sits above the results, not under them: a member
          who found nothing should already know what was not looked at. */}
      <Text style={styles.note}>{SEARCH_NOTE}</Text>

      {results === null ? null : (
        <SectionBlock
          label={SEARCH_RESULTS}
          meta={`${String(results.length)} ${SEARCH_MATCHED}`}
        />
      )}
    </View>
  );

  return (
    <FlatList
      contentContainerStyle={styles.scroll}
      data={results ?? []}
      keyboardShouldPersistTaps="handled"
      keyExtractor={lockerRowKey}
      ListEmptyComponent={
        results === null ? null : (
          <EmptyBlock
            body={SEARCH_NO_MATCH_BODY}
            routine
            title={SEARCH_NO_MATCH}
          />
        )
      }
      ListHeaderComponent={head}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      renderItem={renderItem}
      windowSize={7}
    />
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    note: {
      ...t("small"),
      color: colors.textFaint,
      paddingBottom: spacing[3],
      paddingHorizontal: pageMargin,
    },
    scroll: { paddingBottom: spacing[6] },
    verbRow: {
      alignItems: "flex-start",
      paddingBottom: spacing[2],
      paddingHorizontal: pageMargin,
    },
  });
