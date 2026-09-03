// ACTIVITY — expenses and settlements interleaved, newest first, under the
// three day headings the shared fold decides.
//
// A SETTLEMENT WHERE NEITHER PARTY IS YOU changes a balance and nothing else,
// and the row says so out loud (§6). It is not hidden, because it is why a
// figure moved.
//
// THE WINDOW IS A WINDOW and the foot says so. The feed payload carries no
// count of what lies behind it, so the total is the length of what arrived —
// `tallyWindowFoot` is handed that, and it renders §6's sentence with the real
// denominator rather than an invented one.
import React, { useMemo } from "react";
import { ScrollView, StyleSheet } from "react-native";

import {
  dayBuckets,
  windowOf,
} from "@centraid/blueprints/apps/tally/activity-model";
import { feedFacts } from "@centraid/blueprints/apps/tally/entry-facts";
import { metaSentence, money } from "@centraid/blueprints/apps/tally/format";
import type { ActivityData } from "@centraid/blueprints/apps/tally/types";
import {
  SETTLEMENT_NOT_YOURS,
  VERBS,
  expenseCount,
} from "@centraid/blueprints/apps/tally/view-copy";

import { spacing } from "../../kit/theme";
import { tallyWindowFoot } from "./tally-view-model";
import TallyEntryRow from "./TallyEntryRow";
import TallyNotice from "./TallyNotice";
import type { TallyNoticeProps } from "./TallyNotice";
import { LedgerRow, Section, WindowFoot } from "./TallyParts";

export function settlementTitle(from?: string, to?: string): string {
  return `${from ?? ""} paid ${to ?? ""}`.trim();
}

export interface ActivityViewProps {
  data: ActivityData;
  now: string;
  window: number;
  loaded: boolean;
  notice: TallyNoticeProps;
  onShowMore: () => void;
}

export default function ActivityView(
  props: ActivityViewProps
): React.JSX.Element {
  const view = useMemo(
    () => windowOf(props.data.activity, props.window),
    [props.data.activity, props.window]
  );
  const buckets = useMemo(
    () => dayBuckets(view.rows, props.now),
    [view.rows, props.now]
  );
  const currency = props.data.currency;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <TallyNotice {...props.notice} />

      {buckets.map((bucket) => (
        <Section
          key={bucket.key}
          label={bucket.label}
          meta={expenseCount(bucket.rows.length)}
          filled={bucket.rows.length > 0}
        >
          {bucket.rows.map((row, index) => {
            const key = `${bucket.key}-${index}`;
            if (row.kind === "settlement") {
              const mine =
                row.from_party === props.data.me ||
                row.to_party === props.data.me;
              return (
                <LedgerRow
                  key={key}
                  title={settlementTitle(row.from_name, row.to_name)}
                  meta={metaSentence([
                    row.date,
                    money(row.amount_minor, currency),
                    row.group_name,
                    mine ? "" : SETTLEMENT_NOT_YOURS,
                  ])}
                  figure={{
                    netMinor: 0,
                    text: money(row.amount_minor, currency),
                    sub: "settled",
                    tone: "settled",
                  }}
                />
              );
            }
            return (
              <TallyEntryRow
                key={key}
                facts={feedFacts(row)}
                currency={currency}
                me={props.data.me}
                {...(row.group_name ? { groupName: row.group_name } : {})}
              />
            );
          })}
        </Section>
      ))}

      <WindowFoot
        text={tallyWindowFoot(props.loaded, view.shown, view.total)}
        moreLabel={VERBS.showMore}
        {...(view.more ? { onMore: props.onShowMore } : {})}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: spacing[6] },
});
