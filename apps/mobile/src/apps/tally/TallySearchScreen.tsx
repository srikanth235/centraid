// SEARCH — expense DESCRIPTIONS, and it says so at rest and on a miss.
//
// "Amounts and people are not searched" is §6's own sentence and it appears on
// the empty result, not only in a tooltip nobody opens: a search that quietly
// failed to match a person's name would teach a member the ledger does not
// hold them. The resting state says the same thing before a single key is
// pressed, which is the honest place for a scope to be stated.

import React from "react";
import { ScrollView, StyleSheet } from "react-native";

import { entryFacts } from "@centraid/blueprints/apps/tally/entry-facts";
import { SEARCH } from "@centraid/blueprints/apps/tally/shelves";
import {
  MATCHED_DESCRIPTION,
  SEARCH_COPY,
  SEARCH_PLACEHOLDER,
  SEARCH_SCOPE,
  SECTIONS,
  SECTION_META,
} from "@centraid/blueprints/apps/tally/view-copy";

import { Text } from "../../kit/components/NativeText";
import { spacing, t, useTheme } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import { searchTally } from "./tally-store";
import { TypedField } from "./TallyChips";
import TallyEntryRow from "./TallyEntryRow";
import { Section } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";

export default function TallySearchScreen({
  navigation,
}: TallyScreenProps<"TallySearch">): React.JSX.Element {
  const { colors } = useTheme();
  const vault = useTallyVault();
  const { data, searching, term } = vault.search;
  const results = data?.results ?? [];
  const resting = term.trim() === "";
  const miss = !resting && !searching && data !== null && results.length === 0;

  return (
    <TallyScreen
      current="more"
      shelf={SEARCH}
      onBack={() => navigation.goBack()}
    >
      <ScrollView contentContainerStyle={styles.page}>
        <TypedField
          label={SEARCH_PLACEHOLDER}
          onChange={(next) => void searchTally(next)}
          placeholder={SEARCH_PLACEHOLDER}
          value={term}
        />

        {resting ? (
          <>
            <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
              {SEARCH_COPY.resting.eyebrow}
            </Text>
            <Text style={[styles.title, { color: colors.text }]}>
              {SEARCH_COPY.resting.title}
            </Text>
            <Text style={[styles.body, { color: colors.textSoft }]}>
              {SEARCH_COPY.resting.body}
            </Text>
            <Text style={[styles.note, { color: colors.textFaint }]}>
              {SEARCH_SCOPE}
            </Text>
          </>
        ) : null}

        {searching ? (
          <Text style={[styles.body, { color: colors.textSoft }]}>
            {SEARCH_COPY.searching.lead}
          </Text>
        ) : null}

        {miss ? (
          <>
            <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
              {SEARCH_COPY.miss.eyebrow}
            </Text>
            <Text style={[styles.title, { color: colors.text }]}>
              {SEARCH_COPY.miss.title(term.trim())}
            </Text>
            <Text style={[styles.body, { color: colors.textSoft }]}>
              {SEARCH_COPY.miss.body}
            </Text>
          </>
        ) : null}

        {results.length > 0 && data ? (
          <Section label={SECTIONS.results} meta={SECTION_META.results} filled>
            {results.map((entry) => (
              <TallyEntryRow
                key={entry.expense_id}
                currency={data.currency}
                extra={MATCHED_DESCRIPTION}
                facts={entryFacts(entry)}
                me={data.me}
                {...(entry.group_name ? { groupName: entry.group_name } : {})}
                onPress={() =>
                  navigation.navigate("TallyExpense", {
                    expenseId: entry.expense_id,
                  })
                }
              />
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </TallyScreen>
  );
}

const styles = StyleSheet.create({
  body: {
    ...t("small"),
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  eyebrow: {
    ...t("eyebrow"),
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
  },
  note: {
    ...t("mono"),
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  page: { paddingBottom: spacing[6], padding: spacing[4] },
  title: {
    ...t("title"),
    paddingHorizontal: spacing[4],
    paddingTop: spacing[1],
  },
});
