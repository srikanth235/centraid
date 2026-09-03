import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet } from "react-native";

import {
  COMPOSE_OUTCOMES,
  FIELD_KEYS,
  NO_GROUP_LABEL,
  PLACEHOLDERS,
  SETTLE_COMMIT,
  SETTLE_FOOT_THEIRS,
  SETTLE_FOOT_YOURS,
  SETTLE_HEAD,
  SETTLE_LEDE,
  SETTLE_NOTES,
  SIMPLIFICATION,
  SIMPLIFY_NONE,
  SIMPLIFY_OFF,
  simplifyChanged,
  transferLine,
} from "@centraid/blueprints/apps/tally/compose-copy";
import {
  settleInput,
  settleVerdict,
} from "@centraid/blueprints/apps/tally/draft-model";
import type { SettleDraft } from "@centraid/blueprints/apps/tally/draft-model";
import { metaSentence, money } from "@centraid/blueprints/apps/tally/format";
import { SETTLE } from "@centraid/blueprints/apps/tally/shelves";
import {
  SECTIONS,
  SECTION_META,
} from "@centraid/blueprints/apps/tally/view-copy";
import { settleUpWrite } from "@centraid/blueprints/apps/tally/writes";

import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import { loadTallyGroup } from "./tally-store";
import { issueTallyWrite } from "./tally-writes";
import { Chips, TypedField } from "./TallyChips";
import { FieldRow, LedgerRow, Section } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";

export default function TallySettleScreen({
  navigation,
  route,
}: TallyScreenProps<"TallySettle">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const vault = useTallyVault();
  const replica = useReplica();
  const me = vault.dashboard.me;

  const [draft, setDraft] = useState<SettleDraft>(() => ({
    amount: "",
    fromId: me ?? "",
    groupId: route.params?.groupId ?? null,
    paidOn: vault.now.slice(0, 10),
    toId: route.params?.partyId ?? "",
  }));

  useEffect(() => {
    if (draft.groupId) void loadTallyGroup(draft.groupId);
  }, [draft.groupId]);

  const patch = (next: Partial<SettleDraft>): void =>
    setDraft((prior) => ({ ...prior, ...next }));

  const people = useMemo(() => {
    const names = new Map<string, string>();
    if (me) names.set(me, "You");
    for (const friend of vault.dashboard.friends)
      names.set(friend.party_id, friend.name);
    for (const member of vault.group?.members ?? [])
      names.set(member.party_id, member.name);
    return [...names].map(([id, label]) => ({ id, label }));
  }, [me, vault.dashboard.friends, vault.group]);

  const currency = vault.group?.currency ?? vault.dashboard.currency;
  const verdict = settleVerdict(draft, me);
  const simplification =
    draft.groupId && vault.group?.group?.group_id === draft.groupId
      ? vault.group.simplification
      : undefined;

  const nameOfMember = (partyId: string): string =>
    people.find((person) => person.id === partyId)?.label ?? partyId;

  const commit = (): void => {
    if (!verdict.ok) return;
    void issueTallyWrite(
      replica.session,
      settleUpWrite(settleInput(draft, verdict)),
      { executed: COMPOSE_OUTCOMES.settled }
    ).then((ok) => {
      if (ok) navigation.goBack();
    });
  };

  return (
    <TallyScreen
      current="balances"
      shelf={SETTLE}
      hideBand
      onBack={() => navigation.goBack()}
    >
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.title}>{SETTLE_HEAD}</Text>
        <Text style={styles.lede}>{SETTLE_LEDE}</Text>

        <FieldRow label={FIELD_KEYS.from} note={SETTLE_NOTES.from}>
          <Chips
            label={FIELD_KEYS.from}
            onSelect={(fromId) => patch({ fromId })}
            options={people}
            value={draft.fromId}
          />
        </FieldRow>

        <FieldRow label={FIELD_KEYS.to}>
          <Chips
            label={FIELD_KEYS.to}
            onSelect={(toId) => patch({ toId })}
            options={people}
            value={draft.toId}
          />
        </FieldRow>

        <FieldRow label={FIELD_KEYS.amount}>
          <TypedField
            label={FIELD_KEYS.amount}
            numeric
            onChange={(amount) => patch({ amount })}
            placeholder={PLACEHOLDERS.amount}
            value={draft.amount}
          />
        </FieldRow>

        <FieldRow label={FIELD_KEYS.group} note={SETTLE_NOTES.group}>
          <Chips
            label={FIELD_KEYS.group}
            onSelect={(id) => patch({ groupId: id === "" ? null : id })}
            options={[
              { id: "", label: NO_GROUP_LABEL },
              ...vault.dashboard.groups.map((group) => ({
                id: group.group_id,
                label: group.name,
              })),
            ]}
            value={draft.groupId ?? ""}
          />
        </FieldRow>

        <FieldRow
          label={FIELD_KEYS.bankLine}
          value={SETTLE_NOTES.bankLine}
          note={SETTLE_NOTES.bankLine}
        />

        {simplification ? (
          <Section
            label={SECTIONS.simplification}
            meta={SECTION_META.simplification}
            empty={simplification.opted_in ? SIMPLIFY_NONE : SIMPLIFY_OFF}
            filled={simplification.transfers.length > 0}
          >
            {simplification.transfers.map((transfer) => (
              <LedgerRow
                key={`${transfer.from}-${transfer.to}-${transfer.amount_minor}`}
                title={transferLine(
                  nameOfMember(transfer.from),
                  nameOfMember(transfer.to),
                  money(transfer.amount_minor, currency)
                )}
                act={{
                  label: SETTLE_COMMIT,
                  onPress: () =>
                    patch({
                      amount: (transfer.amount_minor / 100).toFixed(2),
                      fromId: transfer.from,
                      toId: transfer.to,
                    }),
                }}
              />
            ))}
          </Section>
        ) : null}
        {simplification ? (
          <Text style={styles.note}>
            {simplification.opted_in
              ? metaSentence([
                  SIMPLIFICATION,
                  simplifyChanged(
                    simplification.debts_before,
                    simplification.payments_after
                  ),
                ])
              : SIMPLIFICATION}
          </Text>
        ) : null}

        {verdict.refusal ? (
          <Text style={styles.refusal}>{verdict.refusal}</Text>
        ) : null}
        <Text style={styles.foot}>
          {verdict.yours ? SETTLE_FOOT_YOURS : SETTLE_FOOT_THEIRS}
        </Text>
        <Text
          accessibilityRole="button"
          accessibilityState={{ disabled: !verdict.ok }}
          onPress={commit}
          style={[styles.commit, verdict.ok ? undefined : styles.commitOff]}
        >
          {SETTLE_COMMIT}
        </Text>
      </ScrollView>
    </TallyScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    commit: {
      ...t("control"),
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      margin: spacing[4],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
      textAlign: "center",
    },
    commitOff: { borderColor: colors.line, color: colors.textDisabled },
    foot: {
      ...t("mono"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
    },
    lede: {
      ...t("small"),
      color: colors.textSoft,
      paddingHorizontal: spacing[4],
      paddingBottom: spacing[2],
    },
    note: {
      ...t("mono"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[2],
    },
    page: { paddingBottom: spacing[6], paddingTop: spacing[4] },
    refusal: {
      ...t("small"),
      color: colors.net,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    title: { ...t("title"), color: colors.text, paddingHorizontal: spacing[4] },
  });
