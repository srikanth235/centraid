import { File } from "expo-file-system";
import { useEffect, useMemo, useRef, useState } from "react";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  automaticTransferAllowed,
  automaticTransferPlan,
  hydrateBackupConsent,
} from "../../kit/transfer/transfer-consent";
import type { BackupConsentRecord } from "../../kit/transfer/transfer-consent";
import {
  TransferSourceUnavailableError,
  runTransfers,
} from "../../kit/transfer/transfer-run";
import type {
  TransferEntry,
  TransferProgress,
  TransferSend,
} from "../../kit/transfer/transfer-run";
import type { CameraRollScope } from "../../lib/camera-roll/watcher";
import type { MobileReplicaSession } from "../../lib/replica/native-session";
import { backupDeviceMedia } from "../../lib/upload/media-producer";
import { nativeUploadPolicy } from "../../lib/upload/native-policy";
import {
  IN_CLOUD_MESSAGE,
  InCloudOriginalError,
  liveVideoUri,
  openDeviceOriginal,
} from "./device-media";
import { photoTimelineEngine } from "./timeline-engine";
import type { TimelineSnapshot } from "./timeline-engine";
import type { PhotoAsset } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

export type BackupProgress = TransferProgress;

interface PhotoRecord {
  kind: PhotoAsset["kind"];
  capturedAt?: string;
  captureGroupId?: string;
  width?: number;
  height?: number;
  durationS?: number;
}

export interface BackupRunDeps {
  upload: (input: {
    localUri: string;
    filename?: string;
    mediaType: string;
    plaintextSize: number;
    kind: PhotoAsset["kind"];
    capturedAt?: string;
    captureGroupId?: string;
    width?: number;
    height?: number;
    durationS?: number;
    onProgress: (progress: BackupProgress) => void;
  }) => Promise<unknown>;
  onProgress: (progress: BackupProgress) => void;
}

export interface BackupOutcome {
  inCloud: Set<string>;
  paused?: string;
}

function photoEntry(
  asset: PhotoAsset,
  localId: string,
  targetVaultId?: string
): TransferEntry<PhotoRecord> {
  return {
    id: asset.id,
    app: "photos",
    ...(targetVaultId ? { targetVaultId } : {}),
    open: async () => {
      let original: Awaited<ReturnType<typeof openDeviceOriginal>>;
      try {
        original = await openDeviceOriginal(localId);
      } catch (error) {
        if (error instanceof InCloudOriginalError)
          throw new TransferSourceUnavailableError(IN_CLOUD_MESSAGE);
        throw error;
      }
      const companion = await liveVideoUri(original.asset);
      const sends: Array<TransferSend<PhotoRecord>> = [
        {
          bytes: {
            localUri: original.uri,
            ...(asset.filename ? { filename: asset.filename } : {}),
            mediaType: asset.kind === "video" ? "video/mp4" : "image/jpeg",
            plaintextSize: new File(original.uri).size,
          },
          record: {
            kind: asset.kind,
            ...(asset.capturedAt ? { capturedAt: asset.capturedAt } : {}),
            ...(companion ? { captureGroupId: `live:${localId}` } : {}),
            ...(asset.width === undefined ? {} : { width: asset.width }),
            ...(asset.height === undefined ? {} : { height: asset.height }),
            ...(asset.durationS === undefined
              ? {}
              : { durationS: asset.durationS }),
          },
        },
      ];
      if (companion) {
        const companionFile = new File(companion);
        sends.push({
          bytes: {
            localUri: companion,
            filename: companionFile.name,
            mediaType: "video/quicktime",
            plaintextSize: companionFile.size,
          },
          record: {
            kind: "video",
            ...(asset.capturedAt ? { capturedAt: asset.capturedAt } : {}),
            captureGroupId: `live:${localId}`,
          },
        });
      }
      return sends;
    },
  };
}

function photoEntries(
  assets: readonly PhotoAsset[],
  targetVaultId?: string
): Array<TransferEntry<PhotoRecord>> {
  return assets.flatMap((asset) =>
    asset.localId ? [photoEntry(asset, asset.localId, targetVaultId)] : []
  );
}

export async function runBackup(
  selected: readonly PhotoAsset[],
  deps: BackupRunDeps
): Promise<BackupOutcome> {
  const outcome = await runTransfers(photoEntries(selected), {
    onProgress: deps.onProgress,
    send: (send) =>
      deps.upload({
        ...send.bytes,
        ...send.record,
        onProgress: deps.onProgress,
      }),
  });
  return {
    inCloud: outcome.deferred,
    ...(outcome.pausedReason
      ? { paused: `Backup paused: ${outcome.pausedReason}` }
      : {}),
  };
}

export function automaticBackupCandidates(
  consent: BackupConsentRecord | undefined,
  assets: readonly PhotoAsset[]
): PhotoAsset[] {
  return automaticTransferPlan(
    consent,
    assets,
    (asset) => asset.backupState === "local-only" && Boolean(asset.localId)
  );
}

export interface AutomaticBackupState {
  remaining: number;
  sent: number;
  deferred: number;
  running: boolean;
  blocked?: string;
}

const POLICY_BLOCKED =
  "Waiting for a connection that matches the transfer rules below.";
const GATEWAY_BLOCKED = "Waiting for the gateway.";

interface SweepScope {
  session: MobileReplicaSession;
  gatewayBase: string;
  vaultId?: string;
}

async function sweepOnce(
  scope: SweepScope,
  pending: readonly PhotoAsset[],
  report: (
    apply: (current: AutomaticBackupState) => AutomaticBackupState
  ) => void
): Promise<void> {
  const outcome = await runTransfers(photoEntries(pending, scope.vaultId), {
    onProgress: () => undefined,
    send: (send, entry) =>
      backupDeviceMedia(scope.session, scope.gatewayBase, {
        ...send.bytes,
        ...send.record,
        ...(entry.targetVaultId ? { targetVaultId: entry.targetVaultId } : {}),
      }),
  });
  report((current) => ({
    remaining: current.remaining,
    sent: current.sent + outcome.sent,
    deferred: outcome.deferred.size,
    running: false,
    ...(outcome.pausedReason
      ? { blocked: `Backup paused: ${outcome.pausedReason}` }
      : {}),
  }));
}

const SWEEP_SNAPSHOT_TIMEOUT_MS = 30_000;

function settledTimeline(
  timeoutMs = SWEEP_SNAPSHOT_TIMEOUT_MS
): Promise<TimelineSnapshot | undefined> {
  const ready = photoTimelineEngine.getSnapshot();
  if (!ready.loading) return Promise.resolve(ready);
  let unsubscribe = (): void => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = new Promise<TimelineSnapshot>((resolve) => {
    unsubscribe = photoTimelineEngine.subscribe(() => {
      const snapshot = photoTimelineEngine.getSnapshot();
      if (!snapshot.loading) resolve(snapshot);
    });
  });
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  return Promise.race([settled, timedOut]).finally(() => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  });
}

export async function sweepCameraRollBackup(
  scope: CameraRollScope
): Promise<void> {
  const consent = await hydrateBackupConsent();
  if (!automaticTransferAllowed(consent)) return;
  if (!(await nativeUploadPolicy().canTransfer())) return;
  const release = photoTimelineEngine.acquire();
  try {
    photoTimelineEngine.setSession(scope.session, scope.gatewayBase);
    const snapshot = await settledTimeline();
    if (!snapshot) return;
    const candidates = automaticBackupCandidates(consent, snapshot.assets);
    if (candidates.length === 0) return;
    await sweepOnce(
      {
        session: scope.session,
        gatewayBase: scope.gatewayBase,
        ...(scope.vaultId ? { vaultId: scope.vaultId } : {}),
      },
      candidates,
      () => undefined
    );
  } finally {
    release();
  }
}

export function useAutomaticPhotoBackup(
  consent: BackupConsentRecord | undefined
): AutomaticBackupState {
  const { session, gatewayBase, vaultId } = useReplica();
  const timeline = usePhotoTimeline();
  const [state, setState] = useState<AutomaticBackupState>({
    remaining: 0,
    sent: 0,
    deferred: 0,
    running: false,
  });
  const sweeping = useRef(false);
  const candidates = useMemo(
    () => automaticBackupCandidates(consent, timeline.assets),
    [consent, timeline.assets]
  );

  useEffect(() => {
    const start = async (): Promise<void> => {
      if (sweeping.current || candidates.length === 0) return;
      if (!(await nativeUploadPolicy().canTransfer())) {
        setState((current) => ({ ...current, blocked: POLICY_BLOCKED }));
        return;
      }
      if (!session || !gatewayBase) {
        setState((current) => ({ ...current, blocked: GATEWAY_BLOCKED }));
        return;
      }
      sweeping.current = true;
      setState((current) => ({ ...current, running: true }));
      try {
        await sweepOnce(
          { session, gatewayBase, ...(vaultId ? { vaultId } : {}) },
          candidates,
          setState
        );
      } finally {
        sweeping.current = false;
      }
    };
    void start();
  }, [candidates, session, gatewayBase, vaultId]);

  return { ...state, remaining: candidates.length };
}
