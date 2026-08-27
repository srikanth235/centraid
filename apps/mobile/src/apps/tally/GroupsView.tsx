// GROUPS — the shared circles, their nets, and the two row acts that change
// what a member's ledger looks like.
//
// LEAVE AND ARCHIVE EACH ASK FIRST, in §6's own words, and the two confirms
// say different things because the acts are different: leaving keeps your rows
// on the ledger marked departed and asks you to settle first if you can;
// archiving takes the group out of the lists, keeps everything, and needs no
// settled balance. Neither is a delete, and neither pretends to be.
//
// ARCHIVING IS NOT DELETING, so the archived section exists whenever the
// dashboard answered with one — a member can always see what left the lists,
// and every row carries the verb that brings it back.

import React from "react";
import { ScrollView, StyleSheet } from "react-native";

import {
  netFigure,
  groupSubLabel,
} from "@centraid/blueprints/apps/tally/format";
import type { DashboardData } from "@centraid/blueprints/apps/tally/types";
import {
  ARCHIVED_META,
  EMPTY,
  SECTIONS,
  SECTION_META,
  VERBS,
  memberCount,
} from "@centraid/blueprints/apps/tally/view-copy";

import { spacing } from "../../kit/theme";
import TallyNotice from "./TallyNotice";
import type { TallyNoticeProps } from "./TallyNotice";
import { LedgerRow, Section } from "./TallyParts";

export interface GroupsViewProps {
  data: DashboardData;
  notice: TallyNoticeProps;
  onOpenGroup: (groupId: string, name: string) => void;
  onNewGroup: () => void;
  onLeave: (groupId: string, name: string) => void;
  /** `archived` is what the group IS now, so the confirm asks the right
   *  question and the write sends the other boolean. */
  onArchive: (groupId: string, name: string, archived: boolean) => void;
}

export default function GroupsView(props: GroupsViewProps): React.JSX.Element {
  const { data } = props;
  const archived = data.archived_groups ?? [];
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <TallyNotice {...props.notice} />

      <Section
        label={SECTIONS.groups}
        meta={SECTION_META.groups}
        empty={EMPTY.groups}
        filled={data.groups.length > 0}
        act={{ label: VERBS.newGroup, onPress: props.onNewGroup }}
      >
        {data.groups.map((group) => (
          <LedgerRow
            key={group.group_id}
            title={group.name}
            meta={memberCount(group.member_count)}
            figure={{
              netMinor: group.owner_net_minor,
              text: netFigure(group.owner_net_minor, data.currency),
              sub: groupSubLabel(group.owner_net_minor),
            }}
            // ONE quiet verb on touch (§5). Leave is the one that changes what
            // a member owes; archive is on the group's own ledger, beside its
            // figure, where the rest of its acts are.
            act={{
              label: VERBS.leave,
              onPress: () => props.onLeave(group.group_id, group.name),
            }}
            onPress={() => props.onOpenGroup(group.group_id, group.name)}
          />
        ))}
      </Section>

      {data.archived_groups ? (
        <Section
          label={SECTIONS.archived}
          meta={SECTION_META.archived}
          empty={EMPTY.archived}
          filled={archived.length > 0}
        >
          {archived.map((group) => (
            <LedgerRow
              key={group.group_id}
              title={group.name}
              meta={ARCHIVED_META}
              figure={{
                netMinor: group.owner_net_minor,
                text: netFigure(group.owner_net_minor, data.currency),
                sub: groupSubLabel(group.owner_net_minor),
              }}
              act={{
                label: VERBS.unarchive,
                onPress: () =>
                  props.onArchive(group.group_id, group.name, true),
              }}
              onPress={() => props.onOpenGroup(group.group_id, group.name)}
            />
          ))}
        </Section>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingBottom: spacing[6] },
});
