// ONE FRIEND — every part of one net, openable.
//
// THE PART FIGURES ARE THE QUERY'S. `queries/friend.ts` folds them with the
// same `pairwise` engine that produced the net, scoped per group, and returns
// `parts[]` — so the parts sum to the net BY CONSTRUCTION rather than by a
// second balance engine here adding up whichever expenses this route happened
// to load. The section says so in its own foot, which is what makes the claim
// checkable: a member can add the rows up.
//
// THE IOU IS READ-ONLY. A standing obligation lives in People; Tally reads it
// into the net above and never writes one, and the row says which.

import React, { useEffect } from "react";
import { ScrollView, StyleSheet } from "react-native";

import { entryFacts } from "@centraid/blueprints/apps/tally/entry-facts";
import { figureTone, netFigure } from "@centraid/blueprints/apps/tally/format";
import { FRIEND } from "@centraid/blueprints/apps/tally/shelves";
import {
  EMPTY,
  FRIEND_HERO_LEVEL,
  FRIEND_HERO_SUB,
  FRIEND_PARTS_NOTE,
  IOU_META,
  IOU_TITLE,
  SECTIONS,
  SECTION_META,
  VERBS,
  friendHeroOwe,
  friendHeroOwed,
  partSubLabel,
  sharedExpenseCount,
} from "@centraid/blueprints/apps/tally/view-copy";

import { Text } from "../../kit/components/NativeText";
import { spacing, t, useTheme } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import { forgetTally, loadTallyFriend } from "./tally-store";
import TallyEntryRow from "./TallyEntryRow";
import { Hero, LedgerRow, Section } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";

export default function TallyFriendScreen({
  navigation,
  route,
}: TallyScreenProps<"TallyFriend">): React.JSX.Element {
  const { colors } = useTheme();
  const vault = useTallyVault();
  const { partyId } = route.params;

  useEffect(() => {
    void loadTallyFriend(partyId);
    return () => forgetTally("friend");
  }, [partyId]);

  const data = vault.friend;
  const nameOf = new Map(
    vault.dashboard.groups.map((group) => [group.group_id, group.name])
  );

  const body = ((): React.JSX.Element | null => {
    if (!data?.friend) return null;
    const net = data.friend.net_minor;
    const tone = figureTone(net);
    const parts = data.friend.parts ?? [];
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Hero
          figure={netFigure(net, data.currency, "Settled")}
          netMinor={net}
          label={
            tone === "settled"
              ? FRIEND_HERO_LEVEL
              : tone === "net"
                ? friendHeroOwe(data.friend.name)
                : friendHeroOwed(data.friend.name)
          }
          sub={FRIEND_HERO_SUB}
          acts={[
            {
              label: VERBS.settleUp,
              onPress: () => navigation.navigate("TallySettle", { partyId }),
            },
          ]}
        />

        <Section label={SECTIONS.parts} meta={SECTION_META.parts} filled>
          {parts.map((part) => (
            <LedgerRow
              key={part.group_id ?? "no-group"}
              title={part.group_name}
              figure={{
                netMinor: part.net_minor,
                text: netFigure(part.net_minor, data.currency),
                sub: partSubLabel(part.net_minor),
              }}
              {...(part.group_id
                ? {
                    onPress: () =>
                      navigation.navigate("TallyGroup", {
                        groupId: String(part.group_id),
                        name: part.group_name,
                      }),
                  }
                : {})}
            />
          ))}
          {/* READ-ONLY. The obligation lives in People; Tally reads it into
              the net above and never writes one. */}
          <LedgerRow title={IOU_TITLE} meta={IOU_META} />
        </Section>
        <Text style={[styles.note, { color: colors.textFaint }]}>
          {FRIEND_PARTS_NOTE}
        </Text>

        <Section
          label={SECTIONS.together}
          meta={sharedExpenseCount(data.ledger.length)}
          empty={EMPTY.together}
          filled={data.ledger.length > 0}
        >
          {data.ledger.map((entry) => (
            <TallyEntryRow
              key={entry.expense_id}
              currency={data.currency}
              facts={entryFacts(entry)}
              me={data.me}
              {...(entry.group_id && nameOf.get(entry.group_id)
                ? { groupName: String(nameOf.get(entry.group_id)) }
                : {})}
              onPress={() =>
                navigation.navigate("TallyExpense", {
                  expenseId: entry.expense_id,
                })
              }
            />
          ))}
        </Section>
      </ScrollView>
    );
  })();

  return (
    <TallyScreen
      current="balances"
      shelf={FRIEND}
      onBack={() => navigation.goBack()}
    >
      {body}
    </TallyScreen>
  );
}

const styles = StyleSheet.create({
  note: {
    ...t("mono"),
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  page: { paddingBottom: spacing[6] },
});
