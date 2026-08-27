// ONE EXPENSE — what it cost, who paid, how it divided, what that makes yours,
// and the revision list that is the reason an edit is safe (§1, §4).
//
// EVERY PAYER IS NAMED. Several people can front one expense, and each is owed
// back the part they actually put down, so *Paid by* lists them with their
// amounts rather than naming one and rounding the rest away.
//
// THE METHOD IS NOT INFERRED — IT IS READ. `add-expense` records `split_method`
// beside the shares, so *Divided* states the method actually used. An expense
// written before the method was recorded has none, and then the row says how
// many shares there are and points at the table: "Equally" guessed from three
// equal numbers would be exactly the claim a member opened this screen to check.
//
// UNDO IS THE VAULT'S OWN REVERSE WRITE. `queries/history.ts` reports each
// revision's `undo_until`, and `undo-expense` applies that durable pre-edit
// snapshot exactly once — so Undo appears on the revision it would undo, inside
// the window, and nowhere else.

import React, { useEffect, useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { displayText } from "@centraid/blueprints/apps/_shared/untrusted";
import {
  CONFLICT_BOTH,
  CURRENCY_NOTE,
  COMPOSE_OUTCOMES,
  EXPENSE_NOTES,
  EXPENSE_ROWS,
  FIELD_KEYS,
  LIFE_ACTS,
  PAID_IT,
  PENDING_STRIP,
  TRASH_BODY,
  TRASH_TITLE,
  UNDO_SPENT,
  UNDO_VERB,
  dividedValue,
  revisionCount,
  splitFoot,
} from "@centraid/blueprints/apps/tally/compose-copy";
import {
  metaSentence,
  money,
  roleSubLabel,
} from "@centraid/blueprints/apps/tally/format";
import { EXPENSE } from "@centraid/blueprints/apps/tally/shelves";
import { DIVISIONS } from "@centraid/blueprints/apps/tally/split-model";
import type {
  LedgerEntry,
  Revision,
} from "@centraid/blueprints/apps/tally/types";
import { paidBy } from "@centraid/blueprints/apps/tally/view-copy";
import {
  trashExpenseWrite,
  undoExpenseWrite,
} from "@centraid/blueprints/apps/tally/writes";

import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import { forgetTally, loadTallyHistory } from "./tally-store";
import { findEntry } from "./tally-view-model";
import { issueTallyWrite } from "./tally-writes";
import TallyAskSheet from "./TallyAskSheet";
import type { TallyAsk } from "./TallyAskSheet";
import { FieldRow, LedgerRow, Section } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";

/** Is this revision's one-shot undo window still open? A window that has
 *  closed, or a snapshot already applied, offers nothing. */
export function undoIsLive(revision: Revision, nowIso: string): boolean {
  if (revision.undone_at) return false;
  const until = Date.parse(revision.undo_until);
  const now = Date.parse(nowIso);
  return !Number.isNaN(until) && !Number.isNaN(now) && now < until;
}

/** The payers, as one value: who put down what. One payer reads as one name
 *  and one amount, which is what a one-payer expense IS. */
export function paidValue(entry: LedgerEntry, currency: string): string {
  const payers = entry.payers ?? [];
  if (payers.length === 0)
    return `${entry.paid_by_name} · ${money(entry.amount_minor, currency)}`;
  return payers
    .map((payer) => `${payer.name} · ${money(payer.paid_minor, currency)}`)
    .join("  ·  ");
}

/** The recorded method, in the interface's own word — or the share count where
 *  the vault holds no method for this expense. */
export function dividedText(entry: LedgerEntry): string {
  const spec = DIVISIONS.find((row) => row.method === entry.split_method);
  return spec ? spec.label : dividedValue(entry.splits.length);
}

export function currencyValue(entry: LedgerEntry): string {
  const rate = entry.rate_scaled / 10 ** entry.rate_scale;
  return metaSentence([
    `${money(entry.original_amount_minor, entry.original_currency)} at ${rate}`,
    entry.rate_source,
    entry.rate_date,
  ]);
}

export default function TallyExpenseScreen({
  navigation,
  route,
}: TallyScreenProps<"TallyExpense">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const vault = useTallyVault();
  const replica = useReplica();
  const [ask, setAsk] = React.useState<TallyAsk | null>(null);
  const { expenseId } = route.params;

  useEffect(() => {
    void loadTallyHistory(expenseId);
    return () => forgetTally("history");
  }, [expenseId]);

  const entry = findEntry<LedgerEntry>(
    [vault.group?.ledger, vault.friend?.ledger, vault.search.data?.results],
    expenseId
  );

  const currency = vault.group?.currency ?? vault.dashboard.currency;
  const me = vault.group?.me ?? vault.dashboard.me;
  const groupName = vault.group?.group?.name;
  const revisions = vault.history?.revisions ?? null;

  const body = ((): React.JSX.Element => {
    if (!entry) {
      return (
        <View style={styles.absent}>
          <Text style={styles.absentText}>{ABSENT}</Text>
        </View>
      );
    }
    const isMine =
      me !== null &&
      (entry.paid_by === me ||
        (entry.payers ?? []).some((payer) => payer.party_id === me));
    const foreign = entry.original_currency !== entry.settlement_currency;
    return (
      <ScrollView contentContainerStyle={styles.page}>
        {entry.pending === true ? (
          <Text style={styles.strip}>{PENDING_STRIP}</Text>
        ) : null}

        <View style={styles.head}>
          <Text style={styles.figure}>
            {money(entry.amount_minor, currency)}
          </Text>
          <Text style={styles.title}>
            {displayText(entry.description ?? "")}
          </Text>
          <Text style={styles.lede}>
            {metaSentence([
              paidBy(entry.paid_by_name, isMine),
              groupName,
              entry.spent_on,
            ])}
          </Text>
        </View>

        <FieldRow
          label={FIELD_KEYS.paidBy}
          value={paidValue(entry, currency)}
          note={EXPENSE_NOTES.paidBy}
        />
        <FieldRow
          label={FIELD_KEYS.divided}
          value={metaSentence([
            dividedText(entry),
            dividedValue(entry.splits.length),
          ])}
          note={EXPENSE_NOTES.divided}
        />
        <FieldRow
          label={FIELD_KEYS.yourShare}
          value={`${money(entry.your_amount_minor, currency)} · ${roleSubLabel(entry.your_role)}`}
          note={EXPENSE_NOTES.yourShare}
        />
        <FieldRow label={FIELD_KEYS.category} value={entry.category ?? ""} />
        <FieldRow
          label={FIELD_KEYS.group}
          value={groupName ?? ""}
          note={EXPENSE_NOTES.group}
        />
        {foreign ? (
          <FieldRow
            label={FIELD_KEYS.currency}
            value={currencyValue(entry)}
            note={CURRENCY_NOTE}
          />
        ) : null}
        {/* SURFACED, AND HONEST ABOUT ITS DOOR. The memo and the bank line are
            real capabilities only the assistant can write today; the row is
            where they belong, and the note says so. */}
        <FieldRow
          label={FIELD_KEYS.memo}
          value={EXPENSE_ROWS.noMemo}
          note={EXPENSE_NOTES.memo}
        />
        <FieldRow
          label={FIELD_KEYS.bankLine}
          value={EXPENSE_ROWS.noBankLine}
          note={EXPENSE_NOTES.bankLine}
        />

        <Section
          label={EXPENSE_ROWS.splitHead}
          filled={entry.splits.length > 0}
        >
          {entry.splits.map((split) => (
            <LedgerRow
              key={split.party_id}
              title={split.name}
              meta={
                (entry.payers ?? []).some(
                  (payer) => payer.party_id === split.party_id
                ) || split.party_id === entry.paid_by
                  ? PAID_IT
                  : ""
              }
              figure={{
                netMinor: split.share_minor,
                text: money(split.share_minor, currency),
                tone: "settled",
              }}
            />
          ))}
        </Section>
        <Text style={styles.note}>
          {splitFoot(money(entry.amount_minor, currency), entry.splits.length)}
        </Text>

        {entry.intentStatus === "conflict" ? (
          <Text style={styles.note}>{CONFLICT_BOTH}</Text>
        ) : null}

        {revisions ? (
          <Section
            label={EXPENSE_ROWS.revisions}
            meta={revisionCount(revisions.length)}
            empty={EXPENSE_ROWS.noRevisions}
            filled={revisions.length > 0}
          >
            {revisions.map((revision) => (
              <LedgerRow
                key={revision.revision_id}
                title={displayText(revision.operation)}
                meta={revision.recorded_at.slice(0, 16).replace("T", " ")}
                {...(undoIsLive(revision, vault.now)
                  ? {
                      act: {
                        label: UNDO_VERB,
                        onPress: () =>
                          void issueTallyWrite(
                            replica.session,
                            undoExpenseWrite(expenseId, revision.revision_id),
                            { executed: COMPOSE_OUTCOMES.undone }
                          ),
                      },
                    }
                  : {})}
                {...(revision.undone_at ? { chip: UNDO_SPENT } : {})}
              />
            ))}
          </Section>
        ) : null}
        {revisions ? (
          <Text style={styles.note}>{EXPENSE_NOTES.history}</Text>
        ) : null}

        <View style={styles.foot}>
          <Text
            accessibilityRole="button"
            onPress={() => navigation.navigate("TallyAdd", { expenseId })}
            style={styles.footAct}
          >
            {LIFE_ACTS.edit}
          </Text>
          <Text
            accessibilityRole="button"
            onPress={() => navigation.navigate("TallyReceipt", { expenseId })}
            style={styles.footAct}
          >
            {LIFE_ACTS.itemise}
          </Text>
          {/* DESTRUCTIVE IS OUTLINED IN `--net`, never filled. */}
          <Text
            accessibilityRole="button"
            onPress={() =>
              setAsk({
                body: [TRASH_BODY],
                confirm: LIFE_ACTS.trash,
                onConfirm: () => {
                  void issueTallyWrite(
                    replica.session,
                    trashExpenseWrite(expenseId),
                    { executed: COMPOSE_OUTCOMES.trashed }
                  ).then((ok) => {
                    if (ok) navigation.goBack();
                  });
                },
                title: TRASH_TITLE,
              })
            }
            style={[styles.footAct, styles.footDestructive]}
          >
            {LIFE_ACTS.trash}
          </Text>
        </View>
      </ScrollView>
    );
  })();

  return (
    <TallyScreen
      current="activity"
      shelf={EXPENSE}
      hideBand
      onBack={() => navigation.goBack()}
    >
      {body}
      <TallyAskSheet ask={ask} onClose={() => setAsk(null)} />
    </TallyScreen>
  );
}

/** The member arrived by a deep link and the ledger it came from is not
 *  loaded. Stated, rather than an empty expense painted over nothing. */
const ABSENT =
  "This expense is not in any ledger this screen has read · open it from Activity, a group or a friend.";

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    absent: { padding: spacing[4] },
    absentText: { ...t("small"), color: colors.textSoft },
    figure: { ...t("display"), color: colors.text },
    foot: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      marginTop: spacing[4],
      padding: spacing[4],
    },
    footAct: {
      ...t("control"),
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
    },
    footDestructive: { borderColor: colors.net, color: colors.net },
    head: { gap: spacing[1], padding: spacing[4] },
    lede: { ...t("mono"), color: colors.textFaint },
    note: {
      ...t("mono"),
      color: colors.textFaint,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    page: { paddingBottom: spacing[6] },
    strip: {
      ...t("small"),
      backgroundColor: colors.bgSunken,
      color: colors.text,
      padding: spacing[3],
    },
    title: { ...t("title"), color: colors.text },
  });
