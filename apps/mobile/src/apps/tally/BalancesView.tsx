import React, { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  allSettled,
  figureTone,
  money,
  netFigure,
  groupSubLabel,
  personSubLabel,
} from "@centraid/blueprints/apps/tally/format";
import type { DashboardData } from "@centraid/blueprints/apps/tally/types";
import {
  ALL_SETTLED,
  DAY_ONE,
  DAY_ONE_ACT,
  DAY_ONE_SUB,
  EMPTY,
  HERO_LEVEL,
  HERO_OWE,
  HERO_OWED,
  HERO_SETTLED_SUB,
  SECTIONS,
  SECTION_META,
  VERBS,
  balancesHeroSub,
  memberCount,
} from "@centraid/blueprints/apps/tally/view-copy";
import { identityInitials } from "@centraid/design";

import { Text } from "../../kit/components/NativeText";
import { spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { TallyScreenState } from "./tally-view-model";
import TallyNotice from "./TallyNotice";
import type { TallyNoticeProps } from "./TallyNotice";
import { Hero, LedgerRow, Section } from "./TallyParts";

export interface BalancesViewProps {
  data: DashboardData;
  state: TallyScreenState;
  notice: TallyNoticeProps;
  onOpenFriend: (partyId: string, name: string) => void;
  onOpenGroup: (groupId: string, name: string) => void;
  onAddFriend: () => void;
  onNewGroup: () => void;
  onSettle: () => void;
  onAddExpense: () => void;
  onRemind: (friend: {
    party_id: string;
    name: string;
    net_minor: number;
  }) => void;
}

export default function BalancesView(
  props: BalancesViewProps
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { data } = props;
  const net = data.owed_total_minor - data.owe_total_minor;
  const tone = figureTone(net);
  const level =
    allSettled(data.friends.map((friend) => friend.net_minor)) &&
    allSettled(data.groups.map((group) => group.owner_net_minor));
  const dayOne =
    props.state === "dayone" ||
    (data.friends.length === 0 && data.groups.length === 0);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <TallyNotice {...props.notice} />

      {dayOne ? (
        <View style={styles.dayOne}>
          <Text style={styles.dayOneTitle}>{DAY_ONE}</Text>
          <Text style={styles.dayOneBody}>{DAY_ONE_SUB}</Text>
          <Text
            accessibilityRole="button"
            onPress={props.onAddExpense}
            style={styles.dayOneAct}
          >
            {DAY_ONE_ACT}
          </Text>
        </View>
      ) : (
        <>
          <Hero
            figure={netFigure(net, data.currency, "Settled")}
            netMinor={net}
            label={
              tone === "settled"
                ? HERO_LEVEL
                : tone === "net"
                  ? HERO_OWE
                  : HERO_OWED
            }
            sub={
              level
                ? HERO_SETTLED_SUB
                : balancesHeroSub(
                    money(data.owed_total_minor, data.currency),
                    money(data.owe_total_minor, data.currency),
                    data.expense_count ?? 0,
                    data.settlement_count ?? 0
                  )
            }
            acts={[{ label: VERBS.settleUp, onPress: props.onSettle }]}
          />
          {level ? <Text style={styles.settled}>{ALL_SETTLED}</Text> : null}
        </>
      )}

      <Section
        label={SECTIONS.people}
        meta={SECTION_META.people}
        empty={EMPTY.people}
        filled={data.friends.length > 0}
        act={{ label: VERBS.addFriend, onPress: props.onAddFriend }}
      >
        {data.friends.map((friend) => (
          <LedgerRow
            key={friend.party_id}
            initials={friend.initials || identityInitials(friend.name)}
            title={friend.name}
            figure={{
              netMinor: friend.net_minor,
              text: netFigure(friend.net_minor, data.currency),
              sub: personSubLabel(friend.net_minor),
            }}
            {...(friend.net_minor > 0
              ? {
                  act: {
                    label: VERBS.remind,
                    onPress: () => props.onRemind(friend),
                  },
                }
              : {})}
            onPress={() => props.onOpenFriend(friend.party_id, friend.name)}
          />
        ))}
      </Section>

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
            onPress={() => props.onOpenGroup(group.group_id, group.name)}
          />
        ))}
      </Section>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    dayOne: {
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[5],
    },
    dayOneAct: { ...t("control"), color: colors.text, marginTop: spacing[2] },
    dayOneBody: { ...t("small"), color: colors.textSoft },
    dayOneTitle: { ...t("title"), color: colors.text },
    page: { paddingBottom: spacing[6] },
    settled: {
      ...t("small"),
      color: colors.textSoft,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
  });
