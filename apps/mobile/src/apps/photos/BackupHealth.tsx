// THE BACKUP SURFACE — a device question, not a Photos question (#711, S4).
//
// What changed, and why it is not a refactor: this screen used to ask a member
// to pick DEVICE ALBUMS and press "Back up selected albums now", per app, per
// run. docs/decisions.md S4 settles the opposite model — consent once, then
// automatic under one Wi-Fi/charging/roaming policy owned by the frame — so the
// album picker and its 100-line MediaLibrary walk are gone, replaced by the
// consent panel below and the sweep in `photos-backup.ts`. Nothing here selects
// what to back up any more: the answer is "this device".
//
// The switches now read and write the FRAME's policy record
// (`kit/transfer/transfer-policy.ts`) — the same durable rows, a new owner. The
// per-app framing is gone from the copy with them: these rules govern Docs'
// scans and Notes' attachments the moment those enqueue, and saying "Photos"
// anywhere on this screen would be a lie the next PR has to unpick.
//
// WHERE THIS SCREEN GOES NEXT: frame Settings, beside Phone storage. It sits in
// the Photos stack today only because that is where a member can reach it, and
// mounting the consent moment here is this pass's compromise — see the report
// note about first-run. When it moves, this file moves whole; nothing in it is
// Photos-specific except the route that reaches it.

import React, { useEffect, useMemo, useState } from "react";
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

import { formatBytes } from "@centraid/design";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import { t, useTheme } from "../../kit/theme";
import {
  AUTOMATIC_BACKUP_OFF,
  AUTOMATIC_BACKUP_ON,
  STOP_BACKING_UP_ACTION,
  STOP_BACKING_UP_EXPLANATION,
  answerBackupConsent,
  automaticTransferAllowed,
  backupConsentPanel,
  hydrateBackupConsent,
} from "../../kit/transfer/transfer-consent";
import type { BackupConsentRecord } from "../../kit/transfer/transfer-consent";
import {
  DEFAULT_TRANSFER_POLICY,
  TRANSFER_POLICY_SWITCHES,
  hydrateTransferPolicy,
  writeTransferPolicy,
} from "../../kit/transfer/transfer-policy";
import type { TransferPolicy } from "../../kit/transfer/transfer-policy";
import { readTransferQueue } from "../../kit/transfer/transfer-queue";
import type { TransferQueueCounts } from "../../kit/transfer/transfer-queue";
import { authHeader } from "../../lib/gateway";
import { LAST_SUCCESSFUL_SYNC_KEY } from "../../lib/upload/native-policy";
import type { PhotosScreenProps } from "../../navigation";
import { Store } from "../../storage";
import { styles } from "./BackupHealth.styles";
import { IN_CLOUD_MESSAGE } from "./device-media";
import { useAutomaticPhotoBackup } from "./photos-backup";
import PhotosScreen from "./PhotosScreen";
import { CUSTODY_ICON, CUSTODY_LABEL } from "./tile-overlays";

type StorageStatus =
  | { kind: "unavailable" }
  | { kind: "ready"; replicated: number; offsite: number; casAck: string };

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

const EMPTY_QUEUE: TransferQueueCounts = {
  pending: 0,
  bytes: 0,
  failures: [],
  readable: true,
};

export default function BackupHealth(
  _props: PhotosScreenProps<"BackupHealth">
): React.JSX.Element {
  const { colors } = useTheme();
  const { gatewayBase, online } = useReplica();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const [policy, setPolicy] = useState<TransferPolicy>(DEFAULT_TRANSFER_POLICY);
  const [consent, setConsent] = useState<BackupConsentRecord>();
  const [queue, setQueue] = useState<TransferQueueCounts>(EMPTY_QUEUE);
  const [storage, setStorage] = useState<StorageStatus>({
    kind: "unavailable",
  });
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<string>();
  // The sweep runs while this screen is up. It is gated on `consent` and on
  // nothing else — see `automaticBackupCandidates`.
  const automatic = useAutomaticPhotoBackup(consent);
  const consented = automaticTransferAllowed(consent);
  const panel = useMemo(() => backupConsentPanel(policy), [policy]);

  useEffect(() => {
    void hydrateTransferPolicy().then(setPolicy);
    void hydrateBackupConsent().then(setConsent);
    void Store.hydrate<string | undefined>(
      LAST_SUCCESSFUL_SYNC_KEY,
      undefined
    ).then(setLastSuccessfulSync);
  }, []);
  useEffect(() => {
    if (!gatewayBase) return;
    readQueueInto(gatewayBase, setQueue);
    if (online)
      void fetch(`${gatewayBase}/centraid/_gateway/storage/status`, {
        headers: authHeader(),
      })
        .then((response) => response.json())
        .then(
          (body: {
            vaults?: Array<{
              casAck?: string;
              backlog?: { count: number; bytes: number };
              replicated?: { count: number; bytes: number };
            }>;
          }) => {
            const vault = body.vaults?.[0];
            if (vault)
              setStorage({
                kind: "ready",
                replicated: vault.replicated?.count ?? 0,
                offsite: vault.backlog?.count ?? 0,
                casAck: vault.casAck ?? "unknown",
              });
          }
        )
        .catch(() => undefined);
    // The sweep hands rows to the durable queue, so the readout has to follow
    // it; `automatic.sent` is the exact count that moved.
  }, [gatewayBase, online, automatic.sent]);

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

  return (
    // Reached from the More sheet's `Storage` row, so `more` is the current
    // destination — and the band is what leaves this screen now (§F,
    // proto:4953-4954). The back chevron is gone with it: it was the only exit
    // this screen had, and an exit the band already provides twice over does
    // not need a third spelling in the head.
    <PhotosScreen current="more">
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>
          Backup health
        </Text>
      </View>
      <ReplicaStatusBar />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refreshNow} />
        }
      >
        <View
          style={[
            styles.hero,
            {
              backgroundColor: queue.pending ? colors.bgSunken : colors.bgElev,
              borderColor: colors.line,
            },
          ]}
        >
          <Icon
            name={queue.pending ? "cloud" : "check-circle"}
            size={30}
            color={queue.pending ? colors.accent : colors.success}
          />
          <Text style={[styles.heroValue, { color: colors.text }]}>
            {queue.readable ? (
              queue.pending ? (
                <>
                  <Text style={[t("mono"), { color: colors.text }]}>
                    {queue.pending}
                  </Text>{" "}
                  pending
                </>
              ) : (
                "Backup is healthy"
              )
            ) : (
              // The ledger is intact; only this view of it failed. Saying
              // "healthy" here would be a reassurance we cannot support.
              "The queue could not be read on this phone"
            )}
          </Text>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            {queue.readable ? (
              queue.pending ? (
                <>
                  <Text style={[t("mono"), { color: colors.textSoft }]}>
                    {formatBytes(queue.bytes)}
                  </Text>{" "}
                  remaining
                </>
              ) : (
                "The durable queue is empty."
              )
            ) : (
              "Nothing queued has been lost. Free up phone storage and reopen this screen."
            )}
          </Text>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
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
              <Text style={[t("mono"), { color: colors.textSoft }]}>
                {automatic.remaining}
              </Text>{" "}
              on this device only ·{" "}
              <Text style={[t("mono"), { color: colors.textSoft }]}>
                {automatic.sent}
              </Text>{" "}
              sent since this screen opened
            </Text>

            {/* Where the grid's custody mark is TAUGHT. The glyph is silent by
                design — it is a mark, not a caption — and an unlabelled mark
                earns its silence only if something, somewhere, says what it
                means. This is that somewhere: the screen a member already
                opens when they are asking the question the mark answers. */}
            <View style={styles.legend}>
              <View
                style={[styles.legendChip, { backgroundColor: colors.toneMat }]}
              >
                <Icon name={CUSTODY_ICON} size={13} color={colors.textSoft} />
              </View>
              <Text style={[styles.legendText, { color: colors.textSoft }]}>
                On a photograph in the grid, this means it is {CUSTODY_LABEL} —
                on this device and nowhere else.
              </Text>
            </View>
            {automatic.blocked ? (
              <Text style={[styles.unavailable, { color: colors.textSoft }]}>
                {automatic.blocked}
              </Text>
            ) : null}
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
              {/* THE one filled element on this screen (§18). */}
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

        {automatic.deferred ? (
          <View style={[styles.warning, { borderColor: colors.danger }]}>
            <Icon name="cloud-off" size={18} color={colors.danger} />
            <Text style={[styles.warningText, { color: colors.danger }]}>
              <Text style={[t("mono"), { color: colors.danger }]}>
                {automatic.deferred}
              </Text>{" "}
              {automatic.deferred === 1 ? "original is" : "originals are"}{" "}
              {IN_CLOUD_MESSAGE}, so{" "}
              {automatic.deferred === 1 ? "it was" : "they were"} not backed up.
              Download {automatic.deferred === 1 ? "it" : "them"} in the Photos
              app and they will be picked up on the next sweep.
            </Text>
          </View>
        ) : null}

        <Text style={[styles.section, { color: colors.textSoft }]}>
          TRANSFER RULES
        </Text>
        <Text style={[styles.note, { color: colors.textFaint }]}>
          These rules govern every transfer this device makes — photographs,
          scans and attachments alike.
        </Text>
        {TRANSFER_POLICY_SWITCHES.map((rule) => {
          const inert = rule.inert(policy);
          return (
            <View
              key={rule.key}
              style={[styles.rule, { borderBottomColor: colors.line }]}
            >
              <Text
                style={[
                  styles.ruleLabel,
                  { color: inert ? colors.textFaint : colors.text },
                ]}
              >
                {rule.label}
              </Text>
              <Switch
                disabled={inert}
                value={policy[rule.key]}
                onValueChange={(value) =>
                  update({ ...policy, [rule.key]: value })
                }
                trackColor={{ true: colors.accent }}
              />
            </View>
          );
        })}
        <Text style={[styles.section, { color: colors.textSoft }]}>
          STORAGE
        </Text>
        <Text style={[styles.storage, { color: colors.text }]}>
          {storage.kind === "ready" ? (
            <>
              <Text style={[t("mono"), { color: colors.text }]}>
                {storage.replicated}
              </Text>{" "}
              replicated ·{" "}
              <Text style={[t("mono"), { color: colors.text }]}>
                {storage.offsite}
              </Text>{" "}
              offsite · policy {storage.casAck}
            </>
          ) : (
            "Storage policy unavailable offline"
          )}
        </Text>
        {queue.failures.map((failure, index) => (
          <Text key={index} style={[styles.error, { color: colors.danger }]}>
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
    </PhotosScreen>
  );
}

function formatSyncTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? "Unknown"
    : new Date(timestamp).toLocaleString();
}
