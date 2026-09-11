// ONE GROUP'S LEDGER — members with the nets the group engine derived,
// departed members kept on the ledger with the balance they left, and the
// group's expenses newest-first.
//
// THE REMOVAL GUARD LIVES ON THE MEMBER ROW. A member who appears anywhere on
// this ledger cannot be removed, because removing them would make the
// arithmetic unreadable — they are marked departed instead. The guard REFUSES
// and says why, in §6's own sentence, and the sheet it opens carries no
// confirming verb at all: there is nothing to confirm, only something to read.
//
// THE SIMPLIFICATION PROPOSAL SITS BESIDE THE LEDGER IT WOULD REWIRE. Off is
// the default and stays a stated fact; on shows what it changed, in this
// group's own figures, and NOTHING about it is written — the opt-in stores a
// flag, and the transfers are derived at read time.

import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet } from "react-native";

import { appearsOnLedger } from "@centraid/blueprints/apps/tally/activity-model";
import {
  COMPOSE_OUTCOMES,
  DELETE_GROUP_BODY,
  DELETE_GROUP_COMMIT,
  DELETE_GROUP_HEAD,
  RENAME_COMMIT,
  RENAME_HEAD,
  SIMPLIFICATION,
  SIMPLIFY_NONE,
  SIMPLIFY_OFF,
  SIMPLIFY_STOP,
  FIELD_KEYS,
  PLACEHOLDERS,
  simplifyChanged,
  transferLine,
} from "@centraid/blueprints/apps/tally/compose-copy";
import { entryFacts } from "@centraid/blueprints/apps/tally/entry-facts";
import {
  metaSentence,
  money,
  moneyNetFigure,
  moneyTone,
  personSubLabel,
} from "@centraid/blueprints/apps/tally/format";
import { GROUP } from "@centraid/blueprints/apps/tally/shelves";
import type { GroupData } from "@centraid/blueprints/apps/tally/types";
import {
  ARCHIVE_BODY,
  ARCHIVE_BODY_2,
  ARCHIVE_TITLE,
  CO_CONTRIBUTES,
  DEPARTED_META,
  EMPTY,
  GROUP_HERO_LEVEL,
  GROUP_HERO_OWE,
  GROUP_HERO_OWED,
  GROUP_HERO_SUB,
  LEAVE_BODY,
  LEAVE_BODY_2,
  LEAVE_TITLE,
  ON_THE_LEDGER,
  SECTIONS,
  SECTION_META,
  UNARCHIVE_BODY,
  UNARCHIVE_TITLE,
  VERBS,
  expenseCount,
  memberCount,
  OUTCOMES,
  removeAsk,
  removeRefused,
  removeTitle,
  REMOVE_BODY,
} from "@centraid/blueprints/apps/tally/view-copy";
import {
  archiveGroupWrite,
  deleteGroupWrite,
  leaveGroupWrite,
  removeMemberWrite,
  renameGroupWrite,
  setSimplificationWrite,
} from "@centraid/blueprints/apps/tally/writes";
import { zeroMoney } from "@centraid/core/money";

import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { spacing, t, useTheme } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import { forgetTally, loadTallyGroup } from "./tally-store";
import { issueTallyWrite } from "./tally-writes";
import TallyAskSheet from "./TallyAskSheet";
import type { TallyAsk } from "./TallyAskSheet";
import TallyEntryRow from "./TallyEntryRow";
import { Hero, LedgerRow, Section } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import TallyShareGroup from "./TallyShareGroup";
import { useTallyVault } from "./useTallyVault";

/** Whoever a transfer runs between, named off the members the query derived. */
function nameOfMember(data: GroupData, partyId: string): string {
  return (
    data.members.find((member) => member.party_id === partyId)?.name ?? partyId
  );
}

export default function TallyGroupScreen({
  navigation,
  route,
}: TallyScreenProps<"TallyGroup">): React.JSX.Element {
  const { colors } = useTheme();
  const vault = useTallyVault();
  const [ask, setAsk] = useState<TallyAsk | null>(null);
  const replica = useReplica();
  const { groupId } = route.params;

  useEffect(() => {
    void loadTallyGroup(groupId);
    return () => forgetTally("group");
  }, [groupId]);

  const data = vault.group;
  const shared = (data?.members.length ?? 0) > 1;

  const write = (
    built: Parameters<typeof issueTallyWrite>[1],
    executed: string
  ): void => {
    void issueTallyWrite(replica.session, built, { executed });
  };

  // The owner's own net in this group, read off the members list the query
  // derived — not a second fold over the ledger below it.
  const mine = useMemo(
    () =>
      data?.members.find((member) => member.is_me)?.net ??
      zeroMoney(data?.currency ?? "USD"),
    [data]
  );

  const askRemove = (partyId: string, name: string, held: boolean): void =>
    setAsk(
      held
        ? { body: [removeRefused(name)], title: removeTitle(name) }
        : {
            body: [REMOVE_BODY],
            confirm: VERBS.remove,
            onConfirm: () =>
              write(removeMemberWrite(groupId, partyId), OUTCOMES.removed),
            title: removeAsk(name),
          }
    );

  const group = data?.group;
  const heldOnLedger = (partyId: string): boolean =>
    appearsOnLedger(data?.ledger ?? [], partyId);
  const level = Math.abs(mine.amount_minor) < 1;
  const archived = group?.archived_at != null;

  // An expression, not a render function: the frame below is this screen's
  // root, and a `return (<…` ahead of it reads as the root to the rooms gate
  // (`scripts/lint-mobile-rooms.mjs`, R-NY-7).
  const body =
    data && group ? (
      <ScrollView contentContainerStyle={styles.page}>
        <Hero
          figure={moneyNetFigure(mine, "Settled")}
          tone={moneyTone(mine)}
          label={
            level
              ? GROUP_HERO_LEVEL
              : mine.amount_minor < 0
                ? GROUP_HERO_OWE
                : GROUP_HERO_OWED
          }
          sub={GROUP_HERO_SUB}
          acts={[
            {
              label: VERBS.settleUp,
              onPress: () => navigation.navigate("TallySettle", { groupId }),
            },
            {
              label: group.simplify_opt_in ? SIMPLIFY_STOP : VERBS.simplify,
              onPress: () =>
                write(
                  setSimplificationWrite(
                    groupId,
                    data.group?.simplify_opt_in !== true
                  ),
                  data.group?.simplify_opt_in === true
                    ? COMPOSE_OUTCOMES.simplifyOff
                    : COMPOSE_OUTCOMES.simplifyOn
                ),
            },
          ]}
        />

        {data.simplification ? (
          <Section
            label={SECTIONS.simplification}
            meta={SECTION_META.simplification}
            empty={data.simplification.opted_in ? SIMPLIFY_NONE : SIMPLIFY_OFF}
            filled={data.simplification.transfers.length > 0}
          >
            {data.simplification.transfers.map((transfer) => (
              <LedgerRow
                key={`${transfer.from}-${transfer.to}-${transfer.amount.amount_minor}`}
                title={transferLine(
                  nameOfMember(data, transfer.from),
                  nameOfMember(data, transfer.to),
                  money(transfer.amount.amount_minor, transfer.amount.currency)
                )}
              />
            ))}
          </Section>
        ) : null}
        {data.simplification ? (
          <Text style={[styles.note, { color: colors.textFaint }]}>
            {data.simplification.opted_in
              ? metaSentence([
                  SIMPLIFICATION,
                  simplifyChanged(
                    data.simplification.debts_before,
                    data.simplification.payments_after
                  ),
                ])
              : SIMPLIFICATION}
          </Text>
        ) : null}

        <Section
          label={SECTIONS.members}
          meta={metaSentence([
            memberCount(data.members.length),
            SECTION_META.members,
          ])}
          filled={data.members.length > 0}
          act={{
            label: VERBS.rename,
            onPress: () =>
              setAsk({
                body: [],
                confirm: RENAME_COMMIT,
                field: {
                  initial: data.group?.name ?? "",
                  label: FIELD_KEYS.name,
                  placeholder: PLACEHOLDERS.group,
                },
                onConfirm: (name) =>
                  write(
                    renameGroupWrite(groupId, name),
                    COMPOSE_OUTCOMES.groupRenamed
                  ),
                title: RENAME_HEAD,
              }),
          }}
        >
          {data.members.map((member) => (
            // A CONTROL WHOSE ONLY OUTCOME IS NO IS NOT A CONTROL (#1015,
            // tally/findings #4). The row's meta already reads "on the ledger
            // · cannot be removed", so a `Remove` beside it could do nothing
            // but restate the sentence the member has just read. The refusal
            // sheet stays for the race where a member joins the ledger between
            // the draw and the tap — `askRemove` still checks `held`.
            <LedgerRow
              key={member.party_id}
              initials={member.initials}
              title={member.name}
              meta={
                member.departed
                  ? DEPARTED_META
                  : heldOnLedger(member.party_id)
                    ? ON_THE_LEDGER
                    : CO_CONTRIBUTES
              }
              figure={{
                netMinor: member.net.amount_minor,
                text: moneyNetFigure(member.net),
                sub: personSubLabel(member.net.amount_minor),
              }}
              {...(member.departed ||
              member.is_me ||
              heldOnLedger(member.party_id)
                ? {}
                : {
                    act: {
                      label: VERBS.remove,
                      onPress: () =>
                        askRemove(
                          member.party_id,
                          member.name,
                          heldOnLedger(member.party_id)
                        ),
                    },
                  })}
            />
          ))}
        </Section>

        <Section
          label={SECTIONS.ledger}
          meta={metaSentence([
            expenseCount(data.ledger.length),
            SECTION_META.ledger,
          ])}
          empty={EMPTY.ledger}
          filled={data.ledger.length > 0}
          act={{
            label: VERBS.addExpense,
            onPress: () => navigation.navigate("TallyAdd", { groupId }),
          }}
        >
          {data.ledger.map((entry) => (
            <TallyEntryRow
              key={entry.expense_id}
              currency={data.currency}
              facts={entryFacts(entry)}
              me={data.me}
              onPress={() =>
                navigation.navigate("TallyExpense", {
                  expenseId: entry.expense_id,
                })
              }
            />
          ))}
        </Section>

        {/* The group's own life acts, below its ledger: sharing comes first
            because it is the one that ADDS, leaving and archiving each ask
            first, in §6's own words, and deleting states the vault's refusal
            before the question rather than after the press. */}
        <Section label={SECTIONS.groups} meta={SECTION_META.groups} filled>
          <TallyShareGroup groupId={groupId} />
          <LedgerRow
            title={VERBS.leave}
            meta={LEAVE_BODY}
            onPress={() =>
              setAsk({
                body: [LEAVE_BODY, LEAVE_BODY_2],
                confirm: VERBS.leave,
                onConfirm: () =>
                  write(leaveGroupWrite(groupId), COMPOSE_OUTCOMES.left),
                title: LEAVE_TITLE,
              })
            }
          />
          <LedgerRow
            title={archived ? VERBS.unarchive : VERBS.archive}
            meta={archived ? UNARCHIVE_BODY : ARCHIVE_BODY}
            onPress={() =>
              setAsk({
                body: archived
                  ? [UNARCHIVE_BODY]
                  : [ARCHIVE_BODY, ARCHIVE_BODY_2],
                confirm: archived ? VERBS.unarchive : VERBS.archive,
                onConfirm: () =>
                  write(
                    archiveGroupWrite(groupId, !archived),
                    archived
                      ? COMPOSE_OUTCOMES.unarchived
                      : COMPOSE_OUTCOMES.archived
                  ),
                title: archived ? UNARCHIVE_TITLE : ARCHIVE_TITLE,
              })
            }
          />
          <LedgerRow
            title={VERBS.export}
            meta={SECTION_META.archived}
            onPress={() =>
              navigation.navigate("TallySurface", {
                groupId,
                surface: "export",
              })
            }
          />
          <LedgerRow
            title={VERBS.deleteGroup}
            meta={DELETE_GROUP_BODY}
            onPress={() =>
              setAsk({
                body: [DELETE_GROUP_BODY],
                confirm: DELETE_GROUP_COMMIT,
                onConfirm: () =>
                  write(
                    deleteGroupWrite(groupId),
                    COMPOSE_OUTCOMES.groupDeleted
                  ),
                title: DELETE_GROUP_HEAD,
              })
            }
          />
        </Section>
      </ScrollView>
    ) : null;

  return (
    <TallyScreen
      shelf={GROUP}
      shared={shared}
      onBack={() => navigation.goBack()}
    >
      {body}
      <TallyAskSheet ask={ask} onClose={() => setAsk(null)} />
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
