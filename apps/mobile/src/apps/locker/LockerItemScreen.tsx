// ONE ITEM — `locker/item` (README-Locker §1, §5; FLOWS.md).
//
// METADATA READS PLAINLY; A SECRET IS A ROW WITH A VERB, and the row states
// the cost of using it — about thirty seconds, and a receipt. Which rows exist
// is `item-fields.ts`'s answer, shared with the desktop, because "does a card
// have a security code row" is a product law and not a rendering detail.
//
// NOTHING HERE IS REVEALED UNTIL THE MEMBER ASKS. The screen arrives with no
// detail at all: opening the item is itself a per-item gesture, so the permit
// gate stands first and names the field this TYPE seals
// (`format.primarySealedField`) — asking a card for its password would mint a
// permit against a field the item does not have.
//
// THE COUNTDOWN IS ONE CLOCK. A single `now` ticks the screen once a second so
// every revealed row agrees about how long is left; the store's own tick is
// what actually conceals them.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { displayText } from "@centraid/blueprints/apps/_shared/untrusted";
import {
  primarySealedField,
  typeLabel,
} from "@centraid/blueprints/apps/locker/format";
import {
  metadataFieldsFor,
  sealedFieldsFor,
} from "@centraid/blueprints/apps/locker/item-fields";
import {
  ALIAS_NONE,
  ALIAS_NOTE,
  ALIAS_ROW,
  EDIT_CANCEL,
  FIELD_NOTE,
  MATCH_NOTE_DOMAIN,
  MATCH_NOTE_HOST,
} from "@centraid/blueprints/apps/locker/route-copy";
import {
  COMPROMISED_WHY,
  COPY,
  EDIT_ITEM,
  FIELD_LABEL,
  TRASH_CONFIRM_BODY,
} from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { usePendingChanges } from "../../kit/replica/pending-changes";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { LockerScreenProps } from "../../navigation";
import { copyLockerMetadata, copyLockerSecret } from "./locker-clipboard";
import {
  BACK_TO_ITEMS,
  OPEN_ITEM_ACT,
  OPEN_ITEM_BODY,
  OUTSIDE_WINDOW,
  STAR_ITEM,
  TRASH_ITEM,
  UNSTAR_ITEM,
} from "./locker-seat-copy";
import {
  askLockerPermit,
  closeLockerItem,
  concealLockerField,
  confirmLockerPermit,
  dismissLockerPermit,
} from "./locker-store";
import { lockerPendingLine } from "./locker-view-model";
import { starLockerItem, trashLockerItem } from "./locker-writes";
import {
  LockerFieldRow,
  LockerSealedField,
  LockerStrengthField,
  LockerTotpField,
} from "./LockerFields";
import LockerPermitGate from "./LockerPermitGate";
import LockerScreen from "./LockerScreen";
import { useLockerVault } from "./useLockerVault";

const TICK_MS = 1000;

export default function LockerItemScreen({
  navigation,
  route,
}: LockerScreenProps<"LockerItem">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const vault = useLockerVault();
  const { itemId, title, type } = route.params;
  const [now, setNow] = useState(() => Date.now());
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const replica = useReplica();
  const { pending } = usePendingChanges(replica.session);
  const pendingWait = lockerPendingLine(pending);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => closeLockerItem, []);

  const detail = vault.bag.detail?.item_id === itemId ? vault.bag.detail : null;
  const row = vault.rows.find((candidate) => candidate.item_id === itemId);

  const ask = useCallback(
    (field: string) => askLockerPermit({ itemId, field }),
    [itemId]
  );

  const copySealed = useCallback(
    (field: string) => {
      const value = vault.bag.revealed[field];
      if (!value) {
        ask(field);
        return;
      }
      void copyLockerSecret(value, FIELD_LABEL[field] ?? field).then(
        (outcome) => postStatus(outcome.text)
      );
    },
    [ask, vault.bag.revealed]
  );

  const copyPlain = useCallback((value: string, label: string) => {
    void copyLockerMetadata(value, label).then((outcome) =>
      postStatus(outcome.text)
    );
  }, []);

  const sealed = sealedFieldsFor(type);
  const password = vault.bag.revealed.password ?? null;

  return (
    <LockerScreen
      current="items"
      hideBand
      onBack={() => navigation.popTo("LockerHome", { destination: "items" })}
      route="item"
    >
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.head}>
          <Text accessibilityRole="header" style={styles.title}>
            {displayText(title)}
          </Text>
          <Text style={styles.lede}>{typeLabel(type)}</Text>
          {pendingWait ? <Text style={styles.body}>{pendingWait}</Text> : null}
        </View>

        {detail === null ? (
          <View style={styles.gatePrompt}>
            {/* The read itself is what a permit buys, so the screen offers the
                gesture rather than pretending to be still loading. */}
            <Text style={styles.body}>{OPEN_ITEM_BODY}</Text>
            <Button
              label={OPEN_ITEM_ACT}
              onPress={() => ask(primarySealedField(type))}
              variant="primary"
            />
          </View>
        ) : (
          <>
            {detail.compromised ? (
              <LockerFieldRow
                label="Compromised"
                note={COMPROMISED_WHY}
                value="Flagged"
              />
            ) : null}

            {metadataFieldsFor(detail).map((field) => (
              <LockerFieldRow
                acts={
                  field.copy
                    ? [
                        {
                          label: COPY,
                          onPress: () =>
                            copyPlain(field.value, field.copy ?? ""),
                        },
                      ]
                    : undefined
                }
                key={field.label}
                label={field.label}
                value={field.value}
              />
            ))}

            {detail.url ? (
              <LockerFieldRow
                label="Address"
                note={
                  detail.url_match_policy === "exact-host"
                    ? MATCH_NOTE_HOST
                    : MATCH_NOTE_DOMAIN
                }
                value={detail.url}
              />
            ) : null}

            {sealed.map((field) => (
              <LockerSealedField
                field={field.field}
                key={field.field}
                label={field.label}
                now={now}
                {...(field.note ? { note: field.note } : {})}
                onConceal={concealLockerField}
                onCopy={copySealed}
                onReveal={ask}
                revealed={vault.bag.revealed[field.field] ?? null}
                revealedAt={vault.bag.revealedAt[field.field] ?? null}
              />
            ))}

            {password ? <LockerStrengthField password={password} /> : null}

            {detail.otp_seed !== undefined && detail.otp_seed !== null ? (
              <LockerTotpField
                onCopy={(code) => copyPlain(code, "One-time code")}
                onReveal={() => ask("otp_seed")}
                seed={vault.bag.revealed.otp_seed ?? null}
              />
            ) : null}

            {/* The alias is a read the vault does not serve yet (§8's paper
                cut). The row states the gap rather than omitting the field. */}
            <LockerFieldRow
              label={ALIAS_ROW}
              note={ALIAS_NOTE}
              value={detail.alias ?? ALIAS_NONE}
            />

            {detail.notes ? (
              <LockerFieldRow
                label="Memo"
                note={FIELD_NOTE.notes}
                value={detail.notes}
              />
            ) : null}
          </>
        )}

        <View style={styles.acts}>
          <Button
            label={EDIT_ITEM}
            onPress={() => navigation.navigate("LockerEdit", { itemId })}
          />
          {/* The star and the trash are METADATA: they queue like any other
              write, which is the other half of the online-only rule. Both are
              drawn from the list row rather than the detail, because both are
              facts the secret-free payload already carries. */}
          {row ? (
            <Button
              label={row.favorite === true ? UNSTAR_ITEM : STAR_ITEM}
              onPress={() => {
                void starLockerItem(
                  replica.session,
                  itemId,
                  row.favorite === true
                );
              }}
            />
          ) : null}
          <Button
            label={TRASH_ITEM}
            onPress={() => setConfirmingTrash(true)}
            variant="destructive"
          />
          <Button
            label={BACK_TO_ITEMS}
            onPress={() =>
              navigation.popTo("LockerHome", { destination: "items" })
            }
          />
        </View>
        {confirmingTrash ? (
          <View style={styles.confirm}>
            {/* Thirty days, with its star and its tags — the §6 sentence, so
                a member deciding is told what a restore brings back. */}
            <Text style={styles.body}>{TRASH_CONFIRM_BODY}</Text>
            <View style={styles.acts}>
              <Button
                label={EDIT_CANCEL}
                onPress={() => setConfirmingTrash(false)}
              />
              <Button
                label={TRASH_ITEM}
                onPress={() => {
                  setConfirmingTrash(false);
                  void trashLockerItem(replica.session, itemId).then((ok) => {
                    if (ok) {
                      navigation.popTo("LockerHome", { destination: "items" });
                    }
                  });
                }}
                variant="destructive"
              />
            </View>
          </View>
        ) : null}
        {row ? null : <Text style={styles.body}>{OUTSIDE_WINDOW}</Text>}
      </ScrollView>

      <LockerPermitGate
        busy={vault.permitBusy}
        error={vault.permitError}
        field={vault.bag.permitRequest?.field ?? null}
        itemTitle={displayText(title)}
        onCancel={dismissLockerPermit}
        onConfirm={(secret) => void confirmLockerPermit(secret)}
      />
    </LockerScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    acts: {
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[2],
      marginTop: spacing[4],
      padding: spacing[4],
    },
    body: { ...t("small"), color: colors.textSoft },
    confirm: {
      borderColor: colors.net,
      borderWidth: borders.hairline,
      gap: spacing[3],
      margin: spacing[4],
      padding: spacing[3],
    },
    gatePrompt: {
      alignItems: "flex-start",
      gap: spacing[3],
      padding: spacing[4],
    },
    head: { gap: spacing[1], padding: spacing[4] },
    lede: { ...t("mono"), color: colors.textFaint },
    scroll: { paddingBottom: spacing[6] },
    title: { ...t("title"), color: colors.text },
  });
