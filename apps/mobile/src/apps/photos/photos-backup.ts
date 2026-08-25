// Photos' seat on the frame's transfer engine (#711). The serial run, counters
// and failure shape belong to `kit/transfer/transfer-run.ts`; what stays here
// is what only Photos knows — opening a camera-roll original, a Live Photo as
// two durable uploads sharing one capture group, and Photos' own stall words.
//
// `runBackup` is the manual OVERRIDE; `automaticBackupCandidates` is the
// consent-gated default path (S4).

import { File } from "expo-file-system";
import { useEffect, useMemo, useRef, useState } from "react";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { automaticTransferPlan } from "../../kit/transfer/transfer-consent";
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
import type { MobileReplicaSession } from "../../lib/replica/native-session";
import { backupDeviceMedia } from "../../lib/upload/media-producer";
import { nativeUploadPolicy } from "../../lib/upload/native-policy";
import {
  IN_CLOUD_MESSAGE,
  InCloudOriginalError,
  liveVideoUri,
  openDeviceOriginal,
} from "./device-media";
import type { PhotoAsset } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

export type BackupProgress = TransferProgress;

/** Opaque to the engine, which passes it straight back to `send`. */
interface PhotoRecord {
  kind: PhotoAsset["kind"];
  /** Omitted from the upload rather than sent empty: the vault stores the fact
   *  the device had, or nothing. */
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
    /** An asset with no capture time uploads without one rather than being
     *  held back from backup. */
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
  /** Originals that never came down from iCloud. They stay selected, so a
   *  retry is one tap. */
  inCloud: Set<string>;
  /** Already member-facing. */
  paused?: string;
}

/** Bytes resolve LATE, inside `open()`, so a long run never holds fifty
 *  originals open at once. */
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
        // A fact about the entry, not a failure of the run.
        if (error instanceof InCloudOriginalError)
          throw new TransferSourceUnavailableError(IN_CLOUD_MESSAGE);
        throw error;
      }
      // The paired MOV is a distinct durable upload, resolved first because the
      // still's capture group depends on it.
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
            // OMITTED, never `undefined`: absence carries "no capture time".
            ...(asset.capturedAt ? { capturedAt: asset.capturedAt } : {}),
            // MediaLibrary carries no true UTC offset, so none is recorded
            // rather than the device's being fabricated.
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
            // The Next API hands back an extracted file, not a paired asset, so
            // dimensions and duration are simply not on offer.
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

/** No device copy means nothing to send: not deferred, just not in this run. */
function photoEntries(
  assets: readonly PhotoAsset[],
  targetVaultId?: string
): Array<TransferEntry<PhotoRecord>> {
  return assets.flatMap((asset) =>
    asset.localId ? [photoEntry(asset, asset.localId, targetVaultId)] : []
  );
}

/** The MANUAL override (§S4): a member picked these and asked for them now. */
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
    // Photos owns the sentence; the engine owns the reason.
    ...(outcome.pausedReason
      ? { paused: `Backup paused: ${outcome.pausedReason}` }
      : {}),
  };
}

// ── The automatic path (S4) ────────────────────────────────────────────────

/**
 * THE CONSENT GATE, stated once and only once. `local-only` is exactly the set
 * the sweep exists for; everything else is safe, mid-flight, or unopenable.
 * Pure, so an unanswered or declined latch provably returns nothing.
 */
export function automaticBackupCandidates(
  consent: BackupConsentRecord | undefined,
  assets: readonly PhotoAsset[]
): PhotoAsset[] {
  return automaticTransferPlan(
    consent,
    assets,
    // A row that cannot be opened is not a candidate, however it got here.
    (asset) => asset.backupState === "local-only" && Boolean(asset.localId)
  );
}

export interface AutomaticBackupState {
  /** On this device and nowhere else, right now. */
  remaining: number;
  /** Determinate: an exact number is the whole readout, there is no spinner. */
  sent: number;
  /** iCloud-optimised originals. COUNTED AND SHOWN, never silent — otherwise a
   *  member is told everything is backed up while originals sit in the cloud. */
  deferred: number;
  running: boolean;
  /** Stated, never silent. */
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

/** Outside any component, and not stylistically: an async walk reporting
 *  through a callback is an EXTERNAL SYSTEM the hook synchronises with. */
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
    // The queue keeps every row it accepted; the next timeline change or
    // foreground resumes it.
    ...(outcome.pausedReason
      ? { blocked: `Backup paused: ${outcome.pausedReason}` }
      : {}),
  }));
}

/**
 * Deliberately NOT a background service: the durable queue survives process
 * death and re-drains on foreground, so all that is missing between launches is
 * the ENQUEUE, and the walk that finds those photographs already runs wherever
 * Photos is on screen. One sweep at a time — two would double every count.
 */
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
  // Per-hook, not module-scope: the drain lock serialises the device, and this
  // only stops one hook re-entering itself mid-walk.
  const sweeping = useRef(false);
  // Memoised on the SNAPSHOT, which stays referentially stable until the
  // timeline changes; without it the effect re-enters the sweep every render.
  const candidates = useMemo(
    () => automaticBackupCandidates(consent, timeline.assets),
    [consent, timeline.assets]
  );

  useEffect(() => {
    // Re-entered whenever the candidate set changes — what "a photograph was
    // just taken" looks like from here. Idle at zero, so it settles.
    const start = async (): Promise<void> => {
      if (sweeping.current || candidates.length === 0) return;
      // Asked fresh: a sweep must not start on cellular because it was planned
      // on Wi-Fi.
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

  // Derived, never stored, so a photograph that settles stops being counted.
  return { ...state, remaining: candidates.length };
}
