// THE BACKUP SURFACE — a FRAME screen, beside Phone storage (#712).
// NOTHING PHOTOS-SHAPED BELONGS HERE: no `useAutomaticPhotoBackup` (the
// enqueue sweep belongs to Photos; mounting it here too would double-sweep one
// queue) and no Photos custody-mark legend (`kit`/`screens` may not import an
// app — scripts/check-import-boundaries.ts). Reached by deep link from the
// More sheet: exactly ONE Backup surface on the phone.
// EVERY NUMBER IS READ, NEVER INVENTED (#712): the DURABLE QUEUE
// (kit/transfer/transfer-queue.ts — fail-closed; an unreadable ledger is its
// own verdict, never "healthy") and the gateway CUSTODY ROLLUP
// (kit/storage/custody-status.ts — "not yet computed" until the sweep runs).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Platform, Pressable, Switch, View } from "react-native";

import { useConfirmDestructive } from "../kit/components/ConfirmSheet";
import Icon from "../kit/components/Icon";
import { Text } from "../kit/components/NativeText";
import { postStatus } from "../kit/components/status-line";
import { useReplica } from "../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../kit/replica/useReplicaRefresh";
import { SystemPlace } from "../kit/rooms";
import { readCustodyStatus } from "../kit/storage/custody-status";
import type { CustodyStatus } from "../kit/storage/custody-status";
import { freeUpOffer } from "../kit/storage/free-up-space";
import { t, useTheme } from "../kit/theme";
import { backupVerdictCopy } from "../kit/transfer/backup-verdict";
import {
  AUTOMATIC_BACKUP_OFF,
  AUTOMATIC_BACKUP_ON,
  STOP_BACKING_UP_ACTION,
  STOP_BACKING_UP_EXPLANATION,
  answerBackupConsent,
  automaticTransferAllowed,
  backupConsentPanel,
  hydrateBackupConsent,
} from "../kit/transfer/transfer-consent";
import type { BackupConsentRecord } from "../kit/transfer/transfer-consent";
import {
  DEFAULT_TRANSFER_POLICY,
  TRANSFER_POLICY_SWITCHES,
  hydrateTransferPolicy,
  writeTransferPolicy,
} from "../kit/transfer/transfer-policy";
import type { TransferPolicy } from "../kit/transfer/transfer-policy";
import {
  readTransferQueue,
  retryTransfer,
} from "../kit/transfer/transfer-queue";
import type { TransferQueueCounts } from "../kit/transfer/transfer-queue";
import { drainUploadQueueNow } from "../lib/upload/boot";
import { LAST_SUCCESSFUL_SYNC_KEY } from "../lib/upload/native-policy";
import type { SettingsScreenProps } from "../navigation";
import { Store } from "../storage";
import {
  CustodyBlock,
  FREE_UP_APPS,
  FreeUpBlock,
  formatSyncTime,
} from "./BackupHealth.custody";
import { styles } from "./BackupHealth.styles";
import { SHELL_TITLES } from "./shell-copy";
import { useShellParent } from "./shell-places";

const EMPTY_QUEUE: TransferQueueCounts = {
  pending: 0,
  pendingVideos: 0,
  bytes: 0,
  failures: [],
  poisonedFollowups: 0,
  readable: true,
};

// One-shot external read, kept outside the component so the effect stays a
// plain read rather than an in-body state update.
function readQueueInto(
  gatewayBase: string,
  apply: (counts: TransferQueueCounts) => void
): void {
  apply(readTransferQueue(gatewayBase));
}

export default function BackupHealth({
  navigation,
  route,
}: SettingsScreenProps<"BackupHealth">): React.JSX.Element {
  const { colors } = useTheme();
  const backTo = useShellParent();
  // The one confirm (#1015, S7): outlined `--net` verb, the noun in the
  // title, and a status line it can host - none of which `Alert.alert` can
  // draw.
  const { confirmDestructive, confirmSheet } = useConfirmDestructive();

  const { gatewayBase, online, session } = useReplica();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const [policy, setPolicy] = useState<TransferPolicy>(DEFAULT_TRANSFER_POLICY);
  const [consent, setConsent] = useState<BackupConsentRecord>();
  const [queue, setQueue] = useState<TransferQueueCounts>(EMPTY_QUEUE);
  // `undefined` while nothing has been read; `null` when the read FAILED —
  // different sentences, neither a zeroed fold.
  const [custody, setCustody] = useState<CustodyStatus | null>();
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<string>();
  const [backingUp, setBackingUp] = useState(false);
  const consented = automaticTransferAllowed(consent);
  const panel = useMemo(() => backupConsentPanel(policy), [policy]);
  // The rollup is the other half of `complete` (#996 R7): an empty queue is
  // this phone's claim, and the gateway's verified custody is the answer.
  const verdict = useMemo(
    () => backupVerdictCopy(queue, undefined, custody),
    [queue, custody]
  );
  const offer = useMemo(
    () =>
      custody
        ? freeUpOffer(
            {
              computedAt: custody.computedAt,
              freeable: custody.buckets.freeable,
            },
            FREE_UP_APPS
          )
        : null,
    [custody]
  );

  useEffect(() => {
    void hydrateTransferPolicy().then(setPolicy);
    void hydrateBackupConsent().then(setConsent);
    void Store.hydrate<string | undefined>(
      LAST_SUCCESSFUL_SYNC_KEY,
      undefined
    ).then(setLastSuccessfulSync);
  }, []);

  const reread = useCallback((): void => {
    if (!gatewayBase) return;
    readQueueInto(gatewayBase, setQueue);
    if (!online) return;
    void readCustodyStatus(gatewayBase)
      .then(setCustody)
      // A failed read is `null`, stated as "could not be read" — never a
      // fold of zeroes, which would read as an empty library.
      .catch(() => setCustody(null));
  }, [gatewayBase, online]);
  useEffect(reread, [reread]);

  const update = (next: TransferPolicy): void => {
    setPolicy(next);
    writeTransferPolicy(next);
  };
  const stopBackingUp = (): void => {
    confirmDestructive({
      body: STOP_BACKING_UP_EXPLANATION,
      cancelLabel: "Keep backing up",
      noun: "this device",
      onConfirm: () => setConsent(answerBackupConsent("not-now")),
      verb: STOP_BACKING_UP_ACTION,
    });
  };

  // THE ONE COMMIT ON THIS SURFACE (§18): drains the durable queue through the
  // frame's own lock + policy gate and reports the exact count.
  const backUpNow = (): void => {
    setBackingUp(true);
    void drainUploadQueueNow(session)
      .then((summary) => {
        const moved = summary.settled + summary.deduped;
        postStatus(
          moved > 0
            ? `${moved} settled on your vault's home machine.`
            : "Nothing moved — the queue is empty, or the transfer rules below are not met."
        );
        void Store.hydrate<string | undefined>(
          LAST_SUCCESSFUL_SYNC_KEY,
          undefined
        ).then(setLastSuccessfulSync);
      })
      .finally(() => {
        setBackingUp(false);
        reread();
      });
  };

  return (
    <SystemPlace
      backTo={backTo}
      footer={<ReplicaStatusBar />}
      onBack={() => navigation.goBack()}
      onRefresh={refreshNow}
      overlay={confirmSheet}
      refreshing={refreshing}
      title="Backup health"
    >
      {/* NAMES ITS SUBJECT (#1015 B13): this is the last time THIS PHONE
            uploaded, which is a different claim from whether the vault holds
            the bytes. "Never" alone read as a third, contradicting verdict
            above the hero's own. */}
      <Text style={[styles.subtitle, { color: colors.textSoft }]}>
        {lastSuccessfulSync ? (
          <>
            Last upload from this phone:{" "}
            <Text style={[t("mono"), { color: colors.textSoft }]}>
              {formatSyncTime(lastSuccessfulSync)}
            </Text>
          </>
        ) : (
          "This phone has not uploaded anything yet"
        )}
      </Text>
      {route.params?.signalCause ? (
        <View
          accessibilityLabel={`Arrived from ${SHELL_TITLES.needsYou}`}
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={[
            styles.panel,
            {
              backgroundColor: colors.bg,
              borderColor: colors.line,
              borderLeftColor: colors.attention,
              borderLeftWidth: 2,
            },
          ]}
        >
          <Text style={[styles.eyebrow, { color: colors.textFaint }]}>
            FROM NOTIFICATIONS
          </Text>
          <Text style={[styles.body, { color: colors.text }]}>
            {route.params.signalCause}
          </Text>
        </View>
      ) : null}
      {/* THE VERDICT (#712): complete · pending · failing · unreadable.
            Only `failing` takes the `net` rule — as an EDGE, never a fill
            or a red plate (§18). */}
      <View
        style={[
          styles.hero,
          verdict.net ? styles.heroFlagged : null,
          {
            backgroundColor:
              verdict.verdict === "complete" ? colors.bgElev : colors.bgSunken,
            borderColor: colors.line,
            borderLeftColor: verdict.net ? colors.net : "transparent",
          },
        ]}
      >
        <Icon
          name={verdict.icon}
          size={30}
          color={
            verdict.net
              ? colors.net
              : verdict.verdict === "complete"
                ? colors.success
                : colors.accent
          }
        />
        <Text
          style={[
            styles.heroValue,
            { color: verdict.net ? colors.net : colors.text },
          ]}
        >
          {verdict.title}
        </Text>
        <Text style={[styles.meta, { color: colors.textSoft }]}>
          {verdict.detail}
        </Text>
        {/* EXACTLY ONE FILLED CONTROL ON THE SURFACE (§18); while the
              consent question is open THAT is the commit, and once answered
              this is the only thing that moves bytes. */}
        <View style={styles.actions}>
          <Pressable
            accessibilityLabel="Back up now"
            accessibilityRole="button"
            accessibilityState={{ disabled: backingUp }}
            disabled={backingUp}
            onPress={backUpNow}
            style={[
              styles.action,
              consented && !backingUp ? styles.filled : null,
              consented && !backingUp
                ? { backgroundColor: colors.accentFill }
                : { borderColor: colors.line },
            ]}
          >
            <Text
              style={[
                styles.actionText,
                {
                  color: backingUp
                    ? colors.textSoft
                    : consented
                      ? colors.textInv
                      : colors.text,
                },
              ]}
            >
              {backingUp ? "Backing up…" : "Back up now"}
            </Text>
          </Pressable>
        </View>
        {policy.never ? (
          <Text style={[styles.unavailable, { color: colors.net }]}>
            Nothing will move: the transfer rules below say never.
          </Text>
        ) : null}
      </View>

      {/* THE CONSENT MOMENT, or the state it left behind. Never both. */}
      {consented ? (
        <View
          style={[
            styles.panel,
            { backgroundColor: colors.bgElev, borderColor: colors.line },
          ]}
        >
          <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
            Backup
          </Text>
          <Text style={[styles.panelTitle, { color: colors.text }]}>
            {AUTOMATIC_BACKUP_ON}
          </Text>
          <Text style={[styles.body, { color: colors.textSoft }]}>
            New photographs and scans are enqueued as each app finds them, and
            this device drains that queue under the rules below.
          </Text>
          <View style={styles.actions}>
            {/* Outlined, never filled: stopping is not this surface's
                  commit, and not destructive either (§18). */}
            <Pressable
              accessibilityLabel={STOP_BACKING_UP_ACTION}
              accessibilityRole="button"
              onPress={stopBackingUp}
              style={[styles.action, { borderColor: colors.line }]}
            >
              <Text style={[styles.actionText, { color: colors.text }]}>
                {STOP_BACKING_UP_ACTION}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View
          style={[
            styles.panel,
            { backgroundColor: colors.bgElev, borderColor: colors.line },
          ]}
        >
          <Text style={[styles.eyebrow, { color: colors.textSoft }]}>
            {panel.eyebrow}
          </Text>
          <Text style={[styles.panelTitle, { color: colors.text }]}>
            {panel.title}
          </Text>
          <Text style={[styles.body, { color: colors.textSoft }]}>
            {panel.body}
          </Text>
          {panel.facts.map((fact) => (
            <View
              key={fact.label}
              style={[
                styles.fact,
                { borderBottomColor: colors.line },
                // The egress fact takes a 2px `net` rule on its leading edge
                // and nothing else — never a fill.
                fact.net
                  ? { borderLeftColor: colors.net, ...styles.factFlagged }
                  : null,
              ]}
            >
              <Text style={[styles.factLabel, { color: colors.textSoft }]}>
                {fact.label}
              </Text>
              <Text style={[styles.factValue, { color: colors.text }]}>
                {fact.value}
              </Text>
            </View>
          ))}
          {consent ? (
            <Text style={[styles.unavailable, { color: colors.textSoft }]}>
              {AUTOMATIC_BACKUP_OFF}
            </Text>
          ) : null}
          <View style={styles.actions}>
            {/* THE one filled element while the question is open (§18). */}
            <Pressable
              accessibilityLabel={panel.action}
              accessibilityRole="button"
              onPress={() => setConsent(answerBackupConsent("automatic"))}
              style={[
                styles.action,
                styles.filled,
                { backgroundColor: colors.accentFill },
              ]}
            >
              <Text style={[styles.actionText, { color: colors.textInv }]}>
                {panel.action}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={panel.action2}
              accessibilityRole="button"
              onPress={() => setConsent(answerBackupConsent("not-now"))}
              style={[styles.action, { borderColor: colors.line }]}
            >
              <Text style={[styles.actionText, { color: colors.text }]}>
                {panel.action2}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      <Text style={[styles.section, { color: colors.textSoft }]}>
        TRANSFER RULES
      </Text>
      <Text style={[styles.note, { color: colors.textFaint }]}>
        These rules govern every transfer this device makes — photographs, scans
        and attachments alike.
      </Text>
      {TRANSFER_POLICY_SWITCHES.map((rule) => {
        const inert = rule.inert(policy);
        // THE REFUSAL GRAMMAR, RENDERED (#712): four of the five switches go
        // inert depending on the other four; transfer-policy.ts owns the
        // inertReason words, this only places them.
        const inertReason = inert ? rule.inertReason(policy) : undefined;
        return (
          <View
            key={rule.key}
            style={[
              styles.rule,
              { borderBottomColor: colors.line },
              rule.net
                ? { borderLeftColor: colors.net, ...styles.ruleFlagged }
                : null,
            ]}
          >
            <View style={styles.ruleText}>
              <Text
                style={[
                  styles.ruleLabel,
                  {
                    color: inert
                      ? colors.textFaint
                      : rule.net
                        ? colors.net
                        : colors.text,
                  },
                ]}
              >
                {rule.label}
              </Text>
              {inertReason ? (
                <Text style={[styles.ruleReason, { color: colors.textSoft }]}>
                  {inertReason}
                </Text>
              ) : null}
            </View>
            <Switch
              accessibilityLabel={rule.label}
              {...(inertReason ? { accessibilityHint: inertReason } : {})}
              disabled={inert}
              value={policy[rule.key]}
              onValueChange={(value) =>
                update({ ...policy, [rule.key]: value })
              }
              trackColor={{ true: rule.net ? colors.net : colors.accent }}
            />
          </View>
        );
      })}

      <Text style={[styles.section, { color: colors.textSoft }]}>
        WHERE YOUR ORIGINALS ARE
      </Text>
      <CustodyBlock custody={custody} online={online} />

      <Text style={[styles.section, { color: colors.textSoft }]}>
        FREE UP SPACE
      </Text>
      <FreeUpBlock offer={offer} />

      {queue.failures.map((failure) => (
        <View key={failure.itemId} style={styles.failureRow}>
          <Text style={[styles.error, { color: colors.net }]}>
            {failure.filename ?? "Asset"}: {failure.lastError}
            {failure.terminal ? "" : " — trying again"}
          </Text>
          {/* A transfer that gave up needs a verb, not only a sentence
              (#1014, P7): before this it was in no list at all. */}
          {failure.terminal && gatewayBase ? (
            <Pressable
              accessibilityLabel={`Retry ${failure.filename ?? "this transfer"}`}
              accessibilityRole="button"
              onPress={() => {
                retryTransfer(gatewayBase, failure.itemId);
                readQueueInto(gatewayBase, setQueue);
              }}
              style={[styles.settings, { borderColor: colors.line }]}
            >
              <Text style={[styles.settingsText, { color: colors.text }]}>
                Retry
              </Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {/* Bytes durable in the CAS whose canonical write never landed: the
          vault holds the content and has no row for it (F4). The count had
          no reader at all before #1014. */}
      {queue.poisonedFollowups > 0 ? (
        <Text style={[styles.error, { color: colors.net }]}>
          {queue.poisonedFollowups} upload
          {queue.poisonedFollowups === 1 ? "" : "s"} reached your vault but
          could not be filed. Reconnect and reopen this screen; if they stay,
          report it — the bytes are safe.
        </Text>
      ) : null}
      {Platform.OS === "android" ? (
        <Pressable
          accessibilityLabel="Open battery optimization settings"
          accessibilityRole="button"
          style={[styles.settings, { borderColor: colors.line }]}
          onPress={() => void Linking.openSettings()}
        >
          <Icon name="battery-charging" size={18} color={colors.accent} />
          <Text style={[styles.settingsText, { color: colors.text }]}>
            Review battery optimization
          </Text>
        </Pressable>
      ) : null}
    </SystemPlace>
  );
}
