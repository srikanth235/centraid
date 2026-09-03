// ADD AN EXPENSE — two typed fields, and everything else a chip set (§3).
//
// ALL SIX DIVISIONS COMMIT, and the allocation table and the RECONCILE LINE
// change with the division: the odd penny goes to the payer for equal, a penny
// of tolerance for exact amounts, "it will not commit at 99" for percentages,
// weights for shares, an equal base with a per-person adjustment, and typed
// lines. None of that arithmetic is here — `split-model.ts` and `line-model.ts`
// resolve it, `draft-model.ts` turns a draft into a verdict and the exact input
// `add-expense` declares, and this screen renders the verdict. Two seats
// composing one write out of one computation is the whole point.
//
// THE FOOT NAMES WHERE THE WRITE LANDS BEFORE THE COMMIT, not after it, and it
// says the write queues on this device — because on a phone it usually does,
// and discovering that at the commit would be the wrong moment.
//
// THE RATE IS SUPPLIED AT ENTRY. There is no rate provider in this path and
// the vault works with none; where this vault has already been TOLD a rate for
// the same pair it is offered as a prefill, with its source and its date, and
// pressing it fills the fields in rather than deciding anything.
import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  ADD_COMMIT,
  ADD_HEAD,
  ADD_LEDE,
  CURRENCY_CHIPS,
  CURRENCY_NOTE,
  COMPOSE_OUTCOMES,
  EDIT_COMMIT,
  EDIT_HEAD,
  FIELD_KEYS,
  FIELD_NOTES,
  LINE_VERBS,
  NO_GROUP_LABEL,
  PLACEHOLDERS,
  RATE_SUGGESTION_NOTE,
  WHEN_CHIPS,
  addFoot,
  rateSuggestionChip,
} from "@centraid/blueprints/apps/tally/compose-copy";
import {
  CATEGORIES,
  addExpenseInput,
  draftFromEntry,
  editExpenseInput,
  expenseVerdict,
  newExpenseDraft,
  prefillEntries,
} from "@centraid/blueprints/apps/tally/draft-model";
import type { ExpenseDraft } from "@centraid/blueprints/apps/tally/draft-model";
import { money } from "@centraid/blueprints/apps/tally/format";
import { newLineDraft } from "@centraid/blueprints/apps/tally/line-model";
import type { LineDraft } from "@centraid/blueprints/apps/tally/line-model";
import { ADD } from "@centraid/blueprints/apps/tally/shelves";
import {
  DIVISIONS,
  divisionSpec,
} from "@centraid/blueprints/apps/tally/split-model";
import type { Division } from "@centraid/blueprints/apps/tally/split-model";
import type { LedgerEntry } from "@centraid/blueprints/apps/tally/types";
import {
  addExpenseWrite,
  editExpenseWrite,
} from "@centraid/blueprints/apps/tally/writes";

import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { TEST_IDS } from "../../kit/test-ids";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import { loadTallyGroup } from "./tally-store";
import { findEntry } from "./tally-view-model";
import { issueTallyWrite } from "./tally-writes";
import { Chips, TypedField } from "./TallyChips";
import { FieldRow } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";

export default function TallyAddScreen({
  navigation,
  route,
}: TallyScreenProps<"TallyAdd">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const vault = useTallyVault();
  const replica = useReplica();
  const seedGroup = route.params?.groupId ?? null;
  const expenseId = route.params?.expenseId;

  const existing = findEntry<LedgerEntry>(
    [vault.group?.ledger, vault.friend?.ledger, vault.search.data?.results],
    expenseId ?? ""
  );

  const [draft, setDraft] = useState<ExpenseDraft>(() =>
    newExpenseDraft({
      currency: vault.dashboard.currency,
      groupId: seedGroup,
      payerId: vault.dashboard.me ?? "",
      today: vault.now.slice(0, 10),
    })
  );

  const [reopened, setReopened] = useState<LedgerEntry | null>(null);
  if (existing && reopened !== existing) {
    setReopened(existing);
    setDraft(draftFromEntry(existing));
  }

  useEffect(() => {
    if (draft.groupId) void loadTallyGroup(draft.groupId);
  }, [draft.groupId]);

  const patch = (next: Partial<ExpenseDraft>): void =>
    setDraft((prior) => ({ ...prior, ...next }));

  const participants = useMemo(() => {
    if (draft.groupId && vault.group?.group?.group_id === draft.groupId)
      return vault.group.members.map((member) => member.party_id);
    const me = vault.dashboard.me;
    return [
      ...(me ? [me] : []),
      ...vault.dashboard.friends.map((friend) => friend.party_id),
    ];
  }, [draft.groupId, vault.dashboard, vault.group]);

  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of vault.group?.members ?? [])
      names.set(member.party_id, member.name);
    for (const friend of vault.dashboard.friends)
      names.set(friend.party_id, friend.name);
    if (vault.dashboard.me) names.set(vault.dashboard.me, "You");
    return names;
  }, [vault.dashboard, vault.group]);

  const currency = vault.group?.currency ?? vault.dashboard.currency;
  const verdict = expenseVerdict(
    draft,
    participants,
    currency,
    vault.dashboard.me,
    money
  );
  const unit = divisionSpec(draft.division).unit;
  const groupName =
    vault.dashboard.groups.find((group) => group.group_id === draft.groupId)
      ?.name ?? null;

  const suggestions = (vault.dashboard.rate_suggestions ?? []).filter(
    (suggestion) =>
      suggestion.to_currency === currency &&
      (!draft.foreign || suggestion.from_currency === draft.currency)
  );

  const commit = (): void => {
    if (!verdict.ok) return;
    const built = expenseId
      ? editExpenseWrite(editExpenseInput(draft, verdict, currency))
      : addExpenseWrite(addExpenseInput(draft, verdict, currency));
    void issueTallyWrite(replica.session, built, {
      executed: expenseId ? COMPOSE_OUTCOMES.edited : COMPOSE_OUTCOMES.added,
    }).then((ok) => {
      if (ok) navigation.goBack();
    });
  };

  return (
    <TallyScreen
      current="activity"
      shelf={ADD}
      hideBand
      onBack={() => navigation.goBack()}
    >
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.head}>
          <Text style={styles.title}>{expenseId ? EDIT_HEAD : ADD_HEAD}</Text>
          <Text style={styles.lede}>{ADD_LEDE}</Text>
        </View>

        <FieldRow label={FIELD_KEYS.what}>
          <TypedField
            label={FIELD_KEYS.what}
            onChange={(description) => patch({ description })}
            placeholder={PLACEHOLDERS.description}
            value={draft.description}
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

        <FieldRow label={FIELD_KEYS.paidBy} note={FIELD_NOTES.paidBy}>
          <Chips
            label={FIELD_KEYS.paidBy}
            onSelect={(payerId) => patch({ payerId })}
            options={participants.map((id) => ({
              id,
              label: nameOf.get(id) ?? id,
            }))}
            value={draft.payerId}
          />
        </FieldRow>

        <FieldRow label={FIELD_KEYS.group} note={FIELD_NOTES.group}>
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

        <FieldRow label={FIELD_KEYS.category} note={FIELD_NOTES.category}>
          <Chips
            label={FIELD_KEYS.category}
            onSelect={(category) => patch({ category })}
            options={CATEGORIES.map(([id, label]) => ({ id, label }))}
            value={draft.category}
          />
        </FieldRow>

        <FieldRow label={FIELD_KEYS.when} note={FIELD_NOTES.when}>
          <Chips
            label={FIELD_KEYS.when}
            onSelect={(id) => patch({ spentOn: id })}
            options={[
              { id: vault.now.slice(0, 10), label: WHEN_CHIPS.today },
              { id: yesterdayOf(vault.now), label: WHEN_CHIPS.yesterday },
            ]}
            value={draft.spentOn}
          />
          <TypedField
            label={WHEN_CHIPS.pick}
            onChange={(spentOn) => patch({ spentOn })}
            placeholder={vault.now.slice(0, 10)}
            value={draft.spentOn}
          />
        </FieldRow>

        <FieldRow
          label={FIELD_KEYS.currency}
          note={draft.foreign ? CURRENCY_NOTE : FIELD_NOTES.settlementCurrency}
        >
          <Chips
            label={FIELD_KEYS.currency}
            onSelect={(id) => patch({ foreign: id === "other" })}
            options={[
              { id: "home", label: `${CURRENCY_CHIPS.home} · ${currency}` },
              { id: "other", label: CURRENCY_CHIPS.other },
            ]}
            value={draft.foreign ? "other" : "home"}
          />
          {draft.foreign ? (
            <>
              <TypedField
                label={FIELD_KEYS.entered}
                onChange={(value) => patch({ currency: value })}
                placeholder={PLACEHOLDERS.currency}
                value={draft.currency}
              />
              <TypedField
                label={FIELD_KEYS.rate}
                numeric
                onChange={(rate) => patch({ rate })}
                placeholder={PLACEHOLDERS.rate}
                value={draft.rate}
              />
              <TypedField
                label={FIELD_KEYS.source}
                onChange={(rateSource) => patch({ rateSource })}
                placeholder={PLACEHOLDERS.rateSource}
                value={draft.rateSource}
              />
              {suggestions.length > 0 ? (
                <>
                  <Chips
                    label={RATE_SUGGESTION_NOTE}
                    onSelect={(id) => {
                      const hit = suggestions.find(
                        (suggestion) => suggestion.expense_id === id
                      );
                      if (!hit) return;
                      patch({
                        currency: hit.from_currency,
                        rate: String(hit.rate_scaled / 10 ** hit.rate_scale),
                        rateDate: hit.rate_date,
                        rateSource: hit.rate_source,
                      });
                    }}
                    options={suggestions.map((suggestion) => ({
                      id: suggestion.expense_id,
                      label: rateSuggestionChip(
                        String(
                          suggestion.rate_scaled / 10 ** suggestion.rate_scale
                        ),
                        suggestion.rate_source,
                        suggestion.rate_date
                      ),
                    }))}
                  />
                  <Text style={styles.note}>{RATE_SUGGESTION_NOTE}</Text>
                </>
              ) : null}
            </>
          ) : null}
        </FieldRow>

        <FieldRow label={FIELD_KEYS.divided} note={FIELD_NOTES.divided}>
          <Chips
            label={FIELD_KEYS.divided}
            onSelect={(id) => {
              const division = id as Division;
              patch({
                division,
                entries: prefillEntries(
                  division,
                  verdict.amountMinor ?? 0,
                  participants,
                  draft.payerId
                ),
                lines: division === "lines" ? seedLines(draft) : draft.lines,
              });
            }}
            options={DIVISIONS.map((spec) => ({
              id: spec.id,
              label: spec.label,
            }))}
            value={draft.division}
          />
        </FieldRow>

        {/* THE ALLOCATION TABLE CHANGES WITH THE DIVISION. Equal shares are
            derived and typed into nothing; the other four per-person methods
            take one cell each; By line takes lines and the people on them. */}
        {unit === "lines" ? (
          <FieldRow label={FIELD_KEYS.lines} note={FIELD_NOTES.lines}>
            {seedLines(draft).map((line) => (
              <View key={line.lineId} style={styles.line}>
                <TypedField
                  label={LINE_VERBS.whoWasOn}
                  onChange={(description) =>
                    patch({
                      lines: seedLines(draft).map((row) =>
                        row.lineId === line.lineId
                          ? { ...row, description }
                          : row
                      ),
                    })
                  }
                  placeholder={PLACEHOLDERS.line}
                  value={line.description}
                />
                <TypedField
                  label={FIELD_KEYS.amount}
                  numeric
                  onChange={(amount) =>
                    patch({
                      lines: seedLines(draft).map((row) =>
                        row.lineId === line.lineId ? { ...row, amount } : row
                      ),
                    })
                  }
                  placeholder={PLACEHOLDERS.amount}
                  value={line.amount}
                />
                <Chips
                  label={LINE_VERBS.whoWasOn}
                  onSelect={(id) =>
                    patch({
                      lines: seedLines(draft).map((row) =>
                        row.lineId === line.lineId
                          ? {
                              ...row,
                              who: row.who.includes(id)
                                ? row.who.filter((who) => who !== id)
                                : [...row.who, id],
                            }
                          : row
                      ),
                    })
                  }
                  options={participants.map((id) => ({
                    id,
                    label: nameOf.get(id) ?? id,
                  }))}
                  values={line.who}
                />
              </View>
            ))}
            <Text
              accessibilityRole="button"
              onPress={() =>
                patch({ lines: [...seedLines(draft), newLineDraft()] })
              }
              style={styles.addLine}
            >
              {LINE_VERBS.add}
            </Text>
          </FieldRow>
        ) : unit === "derived" ? null : (
          <FieldRow label={FIELD_NOTES.alloc}>
            {participants.map((id) => (
              <View key={id} style={styles.cell}>
                <Text style={styles.cellName}>{nameOf.get(id) ?? id}</Text>
                <TypedField
                  label={nameOf.get(id) ?? id}
                  numeric
                  onChange={(value) =>
                    patch({ entries: { ...draft.entries, [id]: value } })
                  }
                  placeholder={PLACEHOLDERS.amount}
                  value={draft.entries[id] ?? ""}
                />
              </View>
            ))}
          </FieldRow>
        )}

        {/* THE RECONCILE LINE — the division's own, out of the shared
            allocation, and the refusal where there is one. */}
        {verdict.allocation ? (
          <Text style={styles.reconcile}>{verdict.allocation.line}</Text>
        ) : null}
        {verdict.refusal ? (
          <Text style={styles.refusal}>{verdict.refusal}</Text>
        ) : null}

        <Text style={styles.foot}>{addFoot(groupName)}</Text>
        <Text
          accessibilityRole="button"
          accessibilityState={{ disabled: !verdict.ok }}
          onPress={commit}
          style={[styles.commit, verdict.ok ? undefined : styles.commitOff]}
          testID={TEST_IDS.tally.addCommit}
        >
          {expenseId ? EDIT_COMMIT : ADD_COMMIT}
        </Text>
      </ScrollView>
    </TallyScreen>
  );
}

/** A By-line draft opens with one empty line, because a table with no rows is
 *  a control with nothing to press. A SEEDING decision, not a computation —
 *  the arithmetic over the lines is `line-model.ts`'s and is never restated. */
function seedLines(draft: ExpenseDraft): LineDraft[] {
  return draft.lines.length > 0 ? draft.lines : [newLineDraft()];
}

export function yesterdayOf(nowIso: string): string {
  const stamp = Date.parse(`${nowIso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(stamp)) return "";
  return new Date(stamp - 86_400_000).toISOString().slice(0, 10);
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    addLine: { ...t("control"), color: colors.text, paddingTop: spacing[2] },
    cell: { gap: spacing[1] },
    cellName: { ...t("mono"), color: colors.textFaint },
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
    head: { gap: spacing[1], padding: spacing[4] },
    lede: { ...t("small"), color: colors.textSoft },
    line: { gap: spacing[2], paddingBottom: spacing[3] },
    note: { ...t("mono"), color: colors.textFaint },
    page: { paddingBottom: spacing[6] },
    reconcile: {
      ...t("small"),
      color: colors.text,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
    },
    refusal: {
      ...t("small"),
      color: colors.net,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
    title: { ...t("title"), color: colors.text },
  });
