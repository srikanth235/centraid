// THE RECEIPT — the phone's headline surface, because THIS SEAT OWNS CAPTURE.
//
// SURFACES.md gives Receipt to `origin (read on others)`: the camera and the
// OCR pass live here and nowhere else. So this screen carries the verb the
// other seats cannot — *Photograph a receipt*, which opens the frame's own
// scanner — and the lede that says the lines were photographed at the table,
// rather than the other seats' lede that says photographing is the phone's job.
//
// WHAT TALLY OWNS IS THE ALLOCATION. One row per line, a chip per member, and
// the reconciliation stated as ARITHMETIC — six lines total £132.50, the
// expense is £132.50, yours is £41.17 — so a mis-allocation is visible before
// saving rather than after. Every bit of that is `receipt-model.ts`'s, shared,
// so two seats cannot cut one receipt two ways.
//
// A RE-ALLOCATION IS A REVISION AND THE AMOUNT NEVER CHANGES. It answers *who
// had what*, not *what did it cost*; `reallocate-receipt` re-validates that the
// lines still sum to the expense, and the undo window lives on the expense.
import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  COMPOSE_OUTCOMES,
  FIELD_KEYS,
  LINE_VERBS,
  RECEIPT_COMMIT,
  RECEIPT_HEAD,
  RECEIPT_LEDE_ORIGIN,
  RECEIPT_NONE,
  RECEIPT_SHOT_ABSENT,
  unallocatedLines,
} from "@centraid/blueprints/apps/tally/compose-copy";
import { metaSentence, money } from "@centraid/blueprints/apps/tally/format";
import {
  LINE_KIND_LABEL,
  receiptLineItems,
  reconcile,
  selectionOf,
  toggleLine,
} from "@centraid/blueprints/apps/tally/receipt-model";
import type { LineSelection } from "@centraid/blueprints/apps/tally/receipt-model";
import { RECEIPT } from "@centraid/blueprints/apps/tally/shelves";
import type {
  LedgerEntry,
  ReceiptLine,
} from "@centraid/blueprints/apps/tally/types";
import { reallocateReceiptWrite } from "@centraid/blueprints/apps/tally/writes";

import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";
import {
  RECEIPT_CAPTURE_ROW,
  RECEIPT_REALLOCATE_NOTE,
  RECEIPT_SCAN_NOTE,
  RECEIPT_SCAN_VERB,
} from "./tally-seat-copy";
import { findEntry } from "./tally-view-model";
import { issueTallyWrite } from "./tally-writes";
import { Chips } from "./TallyChips";
import { FieldRow } from "./TallyParts";
import TallyScreen from "./TallyScreen";
import { useTallyVault } from "./useTallyVault";

const NO_LINES: readonly ReceiptLine[] = [];

export default function TallyReceiptScreen({
  navigation,
  route,
}: TallyScreenProps<"TallyReceipt">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const vault = useTallyVault();
  const replica = useReplica();
  const { expenseId } = route.params;

  const entry = findEntry<LedgerEntry>(
    [vault.group?.ledger, vault.friend?.ledger, vault.search.data?.results],
    expenseId
  );
  const lines = entry?.receipt?.lines ?? entry?.line_items ?? NO_LINES;
  const [selection, setSelection] = useState<LineSelection>({});
  const [seeded, setSeeded] = useState<readonly ReceiptLine[]>(NO_LINES);
  if (seeded !== lines) {
    setSeeded(lines);
    setSelection(selectionOf(lines));
  }

  const participants = useMemo(
    () => (entry?.splits ?? []).map((split) => split.party_id),
    [entry]
  );
  const nameOf = useMemo(
    () => new Map((entry?.splits ?? []).map((s) => [s.party_id, s.name])),
    [entry]
  );
  const currency = vault.group?.currency ?? vault.dashboard.currency;
  const me = vault.group?.me ?? vault.dashboard.me;

  const sums = useMemo(
    () =>
      reconcile({
        currency,
        expenseMinor: entry?.amount_minor ?? 0,
        lines,
        me,
        participants,
        selection,
      }),
    [currency, entry, lines, me, participants, selection]
  );

  const commit = (): void => {
    if (!entry || !sums.reconciles) return;
    void issueTallyWrite(
      replica.session,
      reallocateReceiptWrite({
        expenseId,
        lineItems: receiptLineItems(
          lines,
          selection
        ) as unknown as readonly Record<string, unknown>[],
        splits: sums.shares.map((share) => ({ ...share })),
      }),
      { executed: COMPOSE_OUTCOMES.reallocated }
    ).then((ok) => {
      if (ok) navigation.goBack();
    });
  };

  return (
    <TallyScreen
      current="activity"
      shelf={RECEIPT}
      hideBand
      onBack={() => navigation.goBack()}
    >
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.title}>{RECEIPT_HEAD}</Text>
        <Text style={styles.lede}>{RECEIPT_LEDE_ORIGIN}</Text>

        {/* THE VERB NO OTHER SEAT HAS. The scanner is the frame's — it holds
            the camera and the OCR consent latch — and Tally allocates what it
            hands back. */}
        <FieldRow label={RECEIPT_CAPTURE_ROW} note={RECEIPT_SCAN_NOTE}>
          <Text
            accessibilityRole="button"
            onPress={() => navigation.navigate("Scan")}
            style={styles.scan}
          >
            {RECEIPT_SCAN_VERB}
          </Text>
        </FieldRow>

        <FieldRow
          label={FIELD_KEYS.receipt}
          value={entry?.receipt ? RECEIPT_SHOT_ABSENT : RECEIPT_NONE}
        />

        {lines.length === 0 ? null : (
          <FieldRow label={FIELD_KEYS.lines} note={RECEIPT_REALLOCATE_NOTE}>
            {lines.map((line) => (
              <View key={line.line_item_id} style={styles.line}>
                <Text style={styles.lineHead}>
                  {metaSentence([
                    line.description,
                    money(line.amount_minor, currency),
                    LINE_KIND_LABEL[line.kind],
                  ])}
                </Text>
                <Chips
                  label={`${LINE_VERBS.whoWasOn} ${line.description}`}
                  onSelect={(partyId) =>
                    setSelection((prior) =>
                      toggleLine(prior, line.line_item_id, partyId)
                    )
                  }
                  options={participants.map((id) => ({
                    id,
                    label: nameOf.get(id) ?? id,
                  }))}
                  values={selection[line.line_item_id] ?? []}
                />
              </View>
            ))}
          </FieldRow>
        )}

        {/* THE RECONCILIATION, AS ARITHMETIC. */}
        <Text style={styles.sums}>{sums.sentence}</Text>
        {sums.unallocated > 0 ? (
          <Text style={styles.warn}>{unallocatedLines(sums.unallocated)}</Text>
        ) : null}

        <Text
          accessibilityRole="button"
          accessibilityState={{ disabled: !sums.reconciles }}
          onPress={commit}
          style={[
            styles.commit,
            sums.reconciles ? undefined : styles.commitOff,
          ]}
        >
          {RECEIPT_COMMIT}
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
    lede: {
      ...t("small"),
      color: colors.textSoft,
      paddingBottom: spacing[2],
      paddingHorizontal: spacing[4],
    },
    line: { gap: spacing[2], paddingBottom: spacing[3] },
    lineHead: { ...t("small"), color: colors.text },
    page: { paddingBottom: spacing[6], paddingTop: spacing[4] },
    scan: {
      ...t("control"),
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      color: colors.text,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
    },
    sums: {
      ...t("small"),
      color: colors.text,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
    },
    title: { ...t("title"), color: colors.text, paddingHorizontal: spacing[4] },
    warn: {
      ...t("mono"),
      color: colors.net,
      paddingHorizontal: spacing[4],
      paddingTop: spacing[2],
    },
  });
