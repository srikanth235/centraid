// SPENDING — what the month went on, and the two figures a splitting tool
// keeps apart.
//
// RESTRAINT IS THE DESIGN (gap register §6): six category rows and the
// paid-versus-share pair. No trend, no chart beyond a proportion bar, no second
// level of category. THE DIFFERENCE IS NOT A SAVING — it is carried in
// balances, and the row says so rather than presenting it as money kept.
//
// NEITHER FOLD IS A BALANCE. Both run over the same decorated feed the Activity
// list reads, so the pair can never disagree with the rows there; the one
// balance engine stays on the query side.

import React, { useEffect, useMemo } from "react";
import { ScrollView, StyleSheet } from "react-native";

import { money } from "@centraid/blueprints/apps/tally/format";
import { SPENDING } from "@centraid/blueprints/apps/tally/shelves";
import {
  categoryTotals,
  monthTotal,
  paidVersusShare,
} from "@centraid/blueprints/apps/tally/spending-model";
import type { ActivityRow } from "@centraid/blueprints/apps/tally/types";
import {
  EMPTY,
  SECTIONS,
  SECTION_META,
  SPENDING_META,
  SPEND_ROWS,
} from "@centraid/blueprints/apps/tally/view-copy";

import { spacing } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import { loadTallyActivity } from "./tally-store";
import { LedgerRow, Section } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";

const NO_ROWS: readonly ActivityRow[] = [];

export default function TallySpendingScreen({
  navigation,
}: TallyScreenProps<"TallySpending">): React.JSX.Element {
  const vault = useTallyVault();

  useEffect(() => {
    if (vault.activity === null) void loadTallyActivity();
  }, [vault.activity]);

  // One stable empty feed, so the three folds below do not recompute on every
  // render while the activity read is still in flight.
  const rows = vault.activity?.activity ?? NO_ROWS;
  const currency = vault.activity?.currency ?? vault.dashboard.currency;
  const totals = useMemo(
    () => categoryTotals(rows, vault.now),
    [rows, vault.now]
  );
  const month = useMemo(() => monthTotal(rows, vault.now), [rows, vault.now]);
  const pair = useMemo(
    () => paidVersusShare(rows, vault.now),
    [rows, vault.now]
  );
  const largest = totals[0]?.total_minor ?? 0;

  return (
    <TallyScreen
      current="more"
      shelf={SPENDING}
      onBack={() => navigation.goBack()}
    >
      <ScrollView contentContainerStyle={styles.page}>
        <Section
          label={SECTIONS.byCategory}
          meta={money(month, currency)}
          empty={EMPTY.spending}
          filled={totals.length > 0}
        >
          {totals.map((total) => (
            <LedgerRow
              key={total.key}
              title={total.label}
              bar={{ largest, value: total.total_minor }}
              figure={{
                netMinor: total.total_minor,
                text: money(total.total_minor, currency),
                tone: "settled",
              }}
            />
          ))}
        </Section>

        <Section
          label={SECTIONS.paidAndOwed}
          meta={SECTION_META.paidAndOwed}
          filled
        >
          <LedgerRow
            title={SPEND_ROWS.paid}
            meta={SPENDING_META.paid}
            figure={{
              netMinor: pair.paid_minor,
              text: money(pair.paid_minor, currency),
              tone: "settled",
            }}
          />
          <LedgerRow
            title={SPEND_ROWS.share}
            meta={SPENDING_META.share}
            figure={{
              netMinor: pair.share_minor,
              text: money(pair.share_minor, currency),
              tone: "settled",
            }}
          />
          <LedgerRow
            title={SPEND_ROWS.difference}
            meta={SPENDING_META.difference}
            figure={{
              netMinor: pair.difference_minor,
              text: money(pair.difference_minor, currency),
              tone: "settled",
            }}
          />
        </Section>
      </ScrollView>
    </TallyScreen>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: spacing[6] },
});
