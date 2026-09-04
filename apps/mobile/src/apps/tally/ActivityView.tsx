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
import { StyleSheet } from "react-native";

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

import { NEWEST_FIRST_ANCHORING } from "../../kit/components/list-anchoring";
import SeatList from "../../kit/components/SeatList";
import { spacing } from "../../kit/theme";
import { tallyWindowFoot } from "./tally-view-model";
import TallyEntryRow from "./TallyEntryRow";
import TallyNotice from "./TallyNotice";
import type { TallyNoticeProps } from "./TallyNotice";
import { LedgerRow, Section, WindowFoot } from "./TallyParts";

/** Who paid whom. Both names come off the row the query decorated. */
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

type ActivityRow = ActivityData["activity"][number];

/** The day headings and their entries as ONE sequence, because a virtualised
 *  list windows a flat list of rows and nothing else: a heading nested around
 *  its rows would pin every row of an open day in memory. */
type LedgerItem =
  | { kind: "day"; key: string; label: string; meta: string }
  | { kind: "entry"; key: string; row: ActivityRow };

export default function ActivityView(
  props: ActivityViewProps
): React.JSX.Element {
  const view = useMemo(
    () => windowOf(props.data.activity, props.window),
    [props.data.activity, props.window]
  );
  const items = useMemo(() => {
    const flat: LedgerItem[] = [];
    for (const bucket of dayBuckets(view.rows, props.now)) {
      flat.push({
        kind: "day",
        key: bucket.key,
        label: bucket.label,
        meta: expenseCount(bucket.rows.length),
      });
      bucket.rows.forEach((row, index) => {
        flat.push({ kind: "entry", key: `${bucket.key}-${index}`, row });
      });
    }
    return flat;
  }, [view.rows, props.now]);
  const currency = props.data.currency;

  const renderRow = (item: LedgerItem): React.JSX.Element => {
    if (item.kind === "day")
      return <Section label={item.label} meta={item.meta} filled={false} />;
    const row = item.row;
    if (row.kind === "settlement") {
      const mine =
        row.from_party === props.data.me || row.to_party === props.data.me;
      return (
        <LedgerRow
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
        facts={feedFacts(row)}
        currency={currency}
        me={props.data.me}
        {...(row.group_name ? { groupName: row.group_name } : {})}
      />
    );
  };

  return (
    <SeatList
      accessibilityLabel="Activity"
      anchoring={NEWEST_FIRST_ANCHORING}
      rows={items}
      keyOf={(item) => item.key}
      renderRow={renderRow}
      contentContainerStyle={styles.page}
      header={<TallyNotice {...props.notice} />}
      footer={
        <WindowFoot
          text={tallyWindowFoot(props.loaded, view.shown, view.total)}
          moreLabel={VERBS.showMore}
          {...(view.more ? { onMore: props.onShowMore } : {})}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: spacing[6] },
});
