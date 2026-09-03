// TRASH — thirty days, restorable whole, and the purge DATE stated.
//
// THERE IS NO EMPTY BUTTON. Purge happens on the date, never on a press, so
// the row carries the day it will go rather than a control that would make the
// countdown a decision. A row whose purge date the query did not carry says
// the rule instead of inventing a day.
//
// RESTORE IS THE ONE TRUE REVERSE WRITE in this list, so it is the one verb
// here — the expense comes back whole, with its splits, revisions and receipt.
import React from "react";
import { ScrollView, StyleSheet } from "react-native";

import { metaSentence, money } from "@centraid/blueprints/apps/tally/format";
import { TRASH } from "@centraid/blueprints/apps/tally/shelves";
import {
  EMPTY,
  OUTCOMES,
  PURGE_UNKNOWN,
  SECTIONS,
  SECTION_META,
  VERBS,
  purgesOn,
  trashedOn,
} from "@centraid/blueprints/apps/tally/view-copy";
import { restoreExpenseWrite } from "@centraid/blueprints/apps/tally/writes";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { spacing } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import { issueTallyWrite } from "./tally-writes";
import { LedgerRow, Section } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";

export default function TallyTrashScreen({
  navigation,
}: TallyScreenProps<"TallyTrash">): React.JSX.Element {
  const vault = useTallyVault();
  const replica = useReplica();
  const trash = vault.dashboard.trash;

  return (
    <TallyScreen
      current="more"
      shelf={TRASH}
      onBack={() => navigation.goBack()}
    >
      <ScrollView contentContainerStyle={styles.page}>
        <Section
          label={SECTIONS.trash}
          meta={SECTION_META.trash}
          empty={EMPTY.trash}
          filled={trash.length > 0}
        >
          {trash.map((row) => (
            <LedgerRow
              key={row.expense_id}
              title={row.description}
              meta={metaSentence([
                row.group_name,
                trashedOn(row.deleted_at.slice(0, 10)),
                row.purge_at
                  ? purgesOn(row.purge_at.slice(0, 10))
                  : PURGE_UNKNOWN,
              ])}
              figure={{
                netMinor: row.amount_minor,
                text: money(row.amount_minor, vault.dashboard.currency),
                tone: "settled",
              }}
              act={{
                label: VERBS.restore,
                onPress: () =>
                  void issueTallyWrite(
                    replica.session,
                    restoreExpenseWrite(row.expense_id),
                    { executed: OUTCOMES.restored }
                  ),
              }}
            />
          ))}
        </Section>
      </ScrollView>
    </TallyScreen>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: spacing[6] },
});
