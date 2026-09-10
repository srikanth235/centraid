import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { RETRY_ACTION } from "@centraid/client/surface-copy";
import { formatRelativeTime } from "@centraid/design";

import { Text } from "../components/NativeText";
import Tappable from "../components/Tappable";
import { SheetRoom } from "../rooms";
import { borders, family, radii, spacing, t, useTheme } from "../theme";
import type { PendingChange } from "./pending-changes";
import {
  humanStatus,
  pendingChangeExplanation,
  pendingChangeStuckLine,
  pendingChangeTitle,
  pendingChangeVerbs,
} from "./pending-copy";

/**
 * The outbox verbs this sheet can fire; `NativeReplicaSession` has them all.
 *
 * No `vaultId` and no `kind` since #996 wave 3: a seat holds ONE vault and ONE
 * outbox, so the id alone addresses the row. Both arguments existed to pick
 * between four mounted sessions and two outboxes, and neither exists.
 */
export interface PendingChangeActions {
  retryPendingWrite: (intentId: string) => Promise<unknown>;
  discardPendingWrite: (intentId: string) => Promise<boolean>;
  cancelPendingChange: (intentId: string) => Promise<boolean>;
  dismissPendingChange: (intentId: string) => void;
}

/** Only what a freshness line needs; the provider's scope satisfies it. */
export interface PendingSheetScope {
  vaultId: string;
  label: string;
  updatedAt?: string;
}

/**
 * Every stopped write on this phone, and what can still be done about each.
 *
 * THE ONE THING THIS SHEET OWES A MEMBER is a way out of a write that stopped.
 * A conflict is the case that proves it: the change is retained with both
 * versions (docs/mobile-offline.md — the client keeps the projected row, the
 * reason and both versions until the member edits, retries or discards it), so
 * this sheet must offer that retry and that discard for EVERY app rather than
 * for whichever seat happened to grow its own affordance.
 *
 * There is deliberately no Edit here. Revising a queued write means composing
 * a new payload, and only the seat that composed the first one holds the form
 * to do it (`revisePendingWrite` is called from the app's own editor, and the
 * browser seat's `PendingWriteActions` takes an `onEdit` from the seat for the
 * same reason). A generic Edit button in a shell sheet would open nothing.
 */
export default function PendingChangesSheet({
  visible,
  onClose,
  pending,
  scopes,
  actions,
  refresh,
}: {
  visible: boolean;
  onClose: () => void;
  pending: readonly PendingChange[];
  scopes: readonly PendingSheetScope[];
  actions: PendingChangeActions | undefined;
  refresh: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const run = (work: Promise<unknown>): void => {
    void work.then(refresh, refresh);
  };
  return (
    <SheetRoom
      cancelLabel="Close"
      onClose={onClose}
      title="Pending changes"
      visible={visible}
    >
      <Text style={[styles.subtitle, { color: colors.textSoft }]}>
        Saved on this phone until each target accepts them
      </Text>
      <ScrollView contentContainerStyle={styles.list}>
        {pending.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textSoft }]}>
            Nothing is waiting.
          </Text>
        ) : (
          pending.map((item) => {
            const verbs = pendingChangeVerbs(item);
            const explanation = pendingChangeExplanation(item);
            const stuck = pendingChangeStuckLine(item);
            const title = pendingChangeTitle(item);
            return (
              <View
                key={item.id}
                style={[
                  styles.card,
                  {
                    backgroundColor: colors.bgElev,
                    borderColor: colors.line,
                  },
                ]}
              >
                <View style={styles.cardCopy}>
                  <Text style={[styles.cardTitle, { color: colors.text }]}>
                    {title}
                  </Text>
                  <Text style={[styles.cardMeta, { color: colors.textSoft }]}>
                    {item.vaultLabel} ·{" "}
                    {/* A held dependent is not "waiting to send": nothing is
                          wrong with it, and it releases when the change in
                          front of it lands (R23). */}
                    {item.heldBadge ?? humanStatus(item.status)}
                  </Text>
                  {explanation ? (
                    <Text
                      style={[
                        styles.reason,
                        {
                          color: verbs.retry ? colors.danger : colors.textSoft,
                        },
                      ]}
                    >
                      {explanation}
                    </Text>
                  ) : null}
                  {stuck ? (
                    <Text style={[styles.stuck, { color: colors.textFaint }]}>
                      {stuck}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.verbs}>
                  {verbs.retry ? (
                    <SheetVerb
                      label={RETRY_ACTION}
                      subject={title}
                      color={colors.accent}
                      onPress={() =>
                        run(
                          actions?.retryPendingWrite(item.id) ??
                            Promise.resolve()
                        )
                      }
                    />
                  ) : null}
                  {verbs.discard ? (
                    <SheetVerb
                      label="Discard"
                      subject={title}
                      color={colors.danger}
                      onPress={() =>
                        run(
                          (
                            actions?.discardPendingWrite(item.id) ??
                            Promise.resolve(false)
                          ).then((discarded) => {
                            // The outbox can settle between the poll that
                            // drew this row and the tap: clearing the
                            // attention row is then the same outcome.
                            if (!discarded)
                              actions?.dismissPendingChange(item.id);
                          })
                        )
                      }
                    />
                  ) : null}
                  {verbs.cancel ? (
                    <SheetVerb
                      label="Cancel"
                      subject={title}
                      color={colors.danger}
                      onPress={() =>
                        run(
                          actions?.cancelPendingChange(item.id) ??
                            Promise.resolve(false)
                        )
                      }
                    />
                  ) : null}
                  {verbs.dismiss ? (
                    <SheetVerb
                      label="Dismiss"
                      subject={title}
                      color={colors.textSoft}
                      onPress={() => {
                        actions?.dismissPendingChange(item.id);
                        refresh();
                      }}
                    />
                  ) : null}
                </View>
              </View>
            );
          })
        )}
        {scopes.map((scope) => (
          <Text
            key={scope.vaultId}
            style={[styles.source, { color: colors.textFaint }]}
          >
            {scope.label}:{" "}
            {scope.updatedAt
              ? `updated ${formatRelativeTime(Date.parse(scope.updatedAt))}`
              : "not updated yet"}
          </Text>
        ))}
      </ScrollView>
    </SheetRoom>
  );
}

/** One verb. The subject rides the accessible name, never the visible text. */
function SheetVerb({
  label,
  subject,
  color,
  onPress,
}: {
  label: string;
  subject: string;
  color: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Tappable accessibilityLabel={`${label} ${subject}`} onPress={onPress}>
      <Text style={[styles.action, { color }]}>{label}</Text>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  action: { fontFamily: family.sansMedium, fontSize: t("mono").fontSize },
  card: {
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    flexDirection: "row",
    gap: 12,
    padding: 14,
  },
  cardCopy: { flex: 1 },
  cardMeta: {
    fontFamily: family.sansRegular,
    fontSize: t("control").fontSize,
    marginTop: 3,
  },
  cardTitle: { fontFamily: family.sansMedium, fontSize: t("body").fontSize },
  empty: {
    fontFamily: family.sansRegular,
    fontSize: t("body").fontSize,
    paddingVertical: 40,
    textAlign: "center",
  },
  list: { gap: spacing[3], paddingBottom: spacing[4], paddingTop: spacing[3] },
  reason: {
    fontFamily: family.sansRegular,
    fontSize: t("control").fontSize,
    marginTop: 6,
  },
  source: {
    fontFamily: family.sansRegular,
    fontSize: t("mono").fontSize,
    marginTop: 4,
  },
  stuck: {
    fontFamily: family.sansRegular,
    fontSize: t("mono").fontSize,
    marginTop: 4,
  },
  subtitle: {
    fontFamily: family.sansRegular,
    fontSize: t("control").fontSize,
    marginTop: 3,
  },
  verbs: { alignItems: "flex-end", gap: 10 },
});
