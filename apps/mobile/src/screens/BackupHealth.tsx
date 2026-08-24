// THE BACKUP SURFACE — a FRAME screen, beside Phone storage (#712).
//
// NOTHING PHOTOS-SHAPED BELONGS HERE:
//
//   * the chrome is the Settings back-chevron header, the same pattern
//     `PhoneStorage.tsx` uses one row above it — never `PhotosScreen`'s
//     claimed band.
//   * no `useAutomaticPhotoBackup`. The sweep that ENQUEUES newly-taken
//     camera-roll photographs belongs to Photos and runs there
//     (`PhotosHome`); mounting it here too would be a second sweep over one
//     queue. This screen carries the frame's half: the DURABLE QUEUE's own
//     state, and the policy that governs whether it may drain at all.
//   * no tile-legend for Photos' custody mark — that is a sentence about a
//     mark in the Photos grid, and `kit`/`screens` may not import an app
//     (`scripts/check-import-boundaries.ts`). The custody vocabulary is
//     taught here in the frame's own words: the rollup's buckets are named
//     and explained under "Where your originals are".
//
// Photos reaches it by deep link — the More sheet's "Backup" row resolves to
// `{ screen: "Settings", params: { screen: "BackupHealth" } }` — so there is
// exactly one Backup surface on the phone, not one per app.
//
// EVERY NUMBER ON THIS SCREEN IS READ, NEVER INVENTED (#712). Two sources,
// and the screen is explicit about which is speaking:
//
//   * the DURABLE QUEUE on this phone (`kit/transfer/transfer-queue.ts`) —
//     what this device is still carrying, and what refused. Fail-closed: an
//     unreadable ledger is its own verdict, never "healthy".
//   * the gateway's CUSTODY ROLLUP (`kit/storage/custody-status.ts`, over
//     `blob.custody_rollup`) — where the originals are, and how much of the
//     local tier is provably safe to release. Until the sweep has run there is
//     nothing to report, and this screen says "not yet computed" rather than
//     printing zeroes as facts.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Switch,
  View,
} from "react-native";

import Icon from "../kit/components/Icon";
import { Text } from "../kit/components/NativeText";
import { postStatus } from "../kit/components/status-line";
import TopSafeArea from "../kit/components/TopSafeArea";
import { useReplica } from "../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../kit/replica/useReplicaRefresh";
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
import { readTransferQueue } from "../kit/transfer/transfer-queue";
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

const EMPTY_QUEUE: TransferQueueCounts = {
  pending: 0,
  pendingVideos: 0,
  bytes: 0,
  failures: [],
  readable: true,
};

// A one-shot read of an EXTERNAL system, kept outside the component so the
// effect that calls it stays a plain external read rather than an in-body state
// update — the same reason `readPendingUploads` lived out here before it moved
// into the frame's `readTransferQueue`.
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
  const { gatewayBase, online, session } = useReplica();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const [policy, setPolicy] = useState<TransferPolicy>(DEFAULT_TRANSFER_POLICY);
  const [consent, setConsent] = useState<BackupConsentRecord>();
  const [queue, setQueue] = useState<TransferQueueCounts>(EMPTY_QUEUE);
  // `undefined` while nothing has been read; `null` when the read FAILED. The
  // two are different sentences and neither is a zeroed fold.
  const [custody, setCustody] = useState<CustodyStatus | null>();
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<string>();
  const [backingUp, setBackingUp] = useState(false);
  const consented = automaticTransferAllowed(consent);
  const panel = useMemo(() => backupConsentPanel(policy), [policy]);
  const verdict = useMemo(() => backupVerdictCopy(queue), [queue]);
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
      // A failed read is `null`, which the surface states as "could not be
      // read" — never a fold of zeroes, which would read as an empty library.
      .catch(() => setCustody(null));
  }, [gatewayBase, online]);
  useEffect(reread, [reread]);

  const update = (next: TransferPolicy): void => {
    setPolicy(next);
    writeTransferPolicy(next);
  };
  const stopBackingUp = (): void => {
    Alert.alert("Stop backing up this device?", STOP_BACKING_UP_EXPLANATION, [
      { text: "Keep backing up" },
      {
        text: STOP_BACKING_UP_ACTION,
        onPress: () => setConsent(answerBackupConsent("not-now")),
      },
    ]);
  };

  // THE ONE COMMIT ON THIS SURFACE (§18). It drains the durable queue through
  // the frame's own lock and policy gate — the same drain a foreground event
  // schedules — and reports the exact count, because a control the member
  // pressed owes them an answer (fallible-action contract).
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
    <TopSafeArea style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back to Settings"
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
        >
          <Icon name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.text }]}>
            Backup health
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSoft }]}>
            Last successful sync:{" "}
            {lastSuccessfulSync ? (
              <Text style={[t("mono"), { color: colors.textSoft }]}>
                {formatSyncTime(lastSuccessfulSync)}
              </Text>
            ) : (
              "Never"
            )}
          </Text>
        </View>
      </View>
      <ReplicaStatusBar />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refreshNow} />
        }
      >
        {route.params?.signalCause ? (
          <View
            accessibilityLabel="Arrived from Notifications"
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
            Only `failing` takes the `net` rule, and it takes it as an EDGE and
            ink — never a fill, never a red plate (§18). */}
        <View
          style={[
            styles.hero,
            verdict.net ? styles.heroFlagged : null,
            {
              backgroundColor:
                verdict.verdict === "complete"
                  ? colors.bgElev
                  : colors.bgSunken,
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
          {/* EXACTLY ONE FILLED CONTROL ON THE SURFACE (§18), and which one it
              is depends on what the member has been asked. While the consent
              question is still open THAT is the commit, and "Back up now" is
              outlined beside it; once it is answered, this is the only thing
              on the screen that moves bytes, so this is the filled one. */}
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

        {/* THE CONSENT MOMENT, or the state it left behind. A device that has
            not answered sees the question; a device that has sees what it is
            doing and how to stop. Never both. */}
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
              {/* Outlined, never filled: stopping is not the commit this
                  surface is for, and it is not destructive either (§18). */}
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
                  // and nothing else — never a fill, never a red dot.
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
          These rules govern every transfer this device makes — photographs,
          scans and attachments alike.
        </Text>
        {TRANSFER_POLICY_SWITCHES.map((rule) => {
          const inert = rule.inert(policy);
          // THE REFUSAL GRAMMAR, RENDERED (#712). Four of these five
          // switches go inert depending on the other four, and until now the
          // screen said nothing about why — a member who turned on "Wi-Fi
          // only" watched two rules below it fade with no account given, which
          // is the half of docs/blueprint-seats.md "Shared engines" 5 that
          // nothing checked. `transfer-policy.ts` owns the words (they are
          // part of the switch's own shape, so a sixth rule cannot arrive
          // without one); this only places them.
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

        {queue.failures.map((failure, index) => (
          <Text key={index} style={[styles.error, { color: colors.net }]}>
            {failure.filename ?? "Asset"}: {failure.lastError}
          </Text>
        ))}
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
      </ScrollView>
    </TopSafeArea>
  );
}
