import React from "react";
import { ScrollView, StyleSheet } from "react-native";

import {
  CONTRIB_EMPTY,
  CONTRIB_META,
  CONTRIB_SECTIONS,
  CONTRIB_VERBS,
  NUDGE_EMPTY,
  NUDGE_META,
  NUDGE_SECTION,
  nudgePrepared,
} from "@centraid/blueprints/apps/tally/compose-copy";
import type {
  ContribRow,
  ContribSections,
  ContribVerb,
} from "@centraid/blueprints/apps/tally/contrib-model";
import type { Nudge } from "@centraid/blueprints/apps/tally/types";
import { NUDGE_PARKED } from "@centraid/blueprints/apps/tally/view-copy";

import { Text } from "../../kit/components/NativeText";
import { spacing, t, useTheme } from "../../kit/theme";
import { WAITING_OWN_SCOPE, waitingCount } from "./tally-seat-copy";
import TallyNotice from "./TallyNotice";
import type { TallyNoticeProps } from "./TallyNotice";
import { LedgerRow, Section } from "./TallyParts";

export interface WaitingViewProps {
  sections: ContribSections;
  nudges: readonly Nudge[];
  names: ReadonlyMap<string, string>;
  notice: TallyNoticeProps;
  onVerb: (verb: ContribVerb, row: ContribRow) => void;
}

const VERB_LABEL: Readonly<Record<ContribVerb, string>> = {
  approvals: CONTRIB_VERBS.approvals,
  approve: CONTRIB_VERBS.approve,
  cancel: CONTRIB_VERBS.cancel,
  decline: CONTRIB_VERBS.decline,
  discard: CONTRIB_VERBS.discard,
  retry: CONTRIB_VERBS.retry,
};

export default function WaitingView(
  props: WaitingViewProps
): React.JSX.Element {
  const { colors } = useTheme();
  const { sections } = props;

  const rowsOf = (rows: readonly ContribRow[]): React.JSX.Element[] =>
    rows.map((row) => (
      <LedgerRow
        key={row.intentId}
        title={row.title}
        meta={`${row.who} · ${row.reason}`}
        chip={row.status.toUpperCase()}
        {...(row.tone === "none" ? {} : { chipTone: row.tone })}
        pending={row.pending}
        {...(row.verbs[0]
          ? {
              act: {
                label: VERB_LABEL[row.verbs[0]],
                onPress: () => props.onVerb(row.verbs[0] as ContribVerb, row),
              },
            }
          : {})}
      />
    ));

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <TallyNotice {...props.notice} />

      <Text style={[styles.scope, { color: colors.textSoft }]}>
        {WAITING_OWN_SCOPE}
      </Text>

      <Section
        label={CONTRIB_SECTIONS.waiting}
        meta={CONTRIB_META.waiting}
        empty={CONTRIB_EMPTY.waiting}
        filled={sections.waiting.length > 0}
      >
        {rowsOf(sections.waiting)}
      </Section>

      <Section
        label={CONTRIB_SECTIONS.inFlight}
        meta={`${waitingCount(sections.total)} · ${CONTRIB_META.inFlight}`}
        empty={CONTRIB_EMPTY.inFlight}
        filled={sections.inFlight.length > 0}
      >
        {rowsOf(sections.inFlight)}
      </Section>

      <Section
        label={CONTRIB_SECTIONS.ended}
        meta={CONTRIB_META.ended}
        empty={CONTRIB_EMPTY.ended}
        filled={sections.ended.length > 0}
      >
        {rowsOf(sections.ended)}
      </Section>

      <Section
        label={NUDGE_SECTION}
        meta={NUDGE_META}
        empty={NUDGE_EMPTY}
        filled={props.nudges.length > 0}
      >
        {props.nudges.map((nudge) => (
          <LedgerRow
            key={nudge.nudge_id}
            title={nudgePrepared(
              props.names.get(nudge.party_id) ?? nudge.party_id,
              nudge.prepared_at.slice(0, 10)
            )}
            meta={NUDGE_PARKED}
            {...(nudge.note ? { chip: "NOTE", chipTone: "seam" as const } : {})}
          />
        ))}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: spacing[6] },
  scope: {
    ...t("mono"),
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
});
