// Photos' seat on the frame's transfer engine (#711, S4).
//
// The serial run, the counters and the failure shape moved to
// `kit/transfer/transfer-run.ts` — none of it was ever about photographs, and
// Docs' scans and Notes' attachments are the declared next callers
// (docs/blueprint-seats.md §Shared engines). What is left here is what only
// Photos knows: how to open a camera-roll original, that a Live Photo is two
// durable uploads sharing one capture group, and the words Photos uses when a
// run stalls.
//
// It also holds the S4 half of the model: which photographs the AUTOMATIC
// sweep is allowed to enqueue. `runBackup` below is now the manual OVERRIDE —
// the north star keeps one too — and `automaticBackupCandidates` is the
// consent-gated default path.

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

/** Kept as the name PhotosHome already imports; the shape is the engine's. */
export type BackupProgress = TransferProgress;

/** The canonical facts Photos' producer needs beside the bytes. Opaque to the
 *  engine, which passes it straight back to `send`. */
interface PhotoRecord {
  kind: PhotoAsset["kind"];
  capturedAt: string;
  captureGroupId?: string;
  width?: number;
  height?: number;
  durationS?: number;
}

export interface BackupRunDeps {
  /** `backupDeviceMedia`, bound to the session and gateway by the caller. */
  upload: (input: {
    localUri: string;
    filename?: string;
    mediaType: string;
    plaintextSize: number;
    kind: PhotoAsset["kind"];
    capturedAt: string;
    captureGroupId?: string;
    width?: number;
    height?: number;
    durationS?: number;
    onProgress: (progress: BackupProgress) => void;
  }) => Promise<unknown>;
  onProgress: (progress: BackupProgress) => void;
}

export interface BackupOutcome {
  /** Assets whose originals never came down from iCloud. Never dropped on the
   *  floor: they stay selected so a retry is one tap. */
  inCloud: Set<string>;
  /** Set when the run stopped early; the message is already member-facing. */
  paused?: string;
}

/**
 * Turn one timeline asset into an engine entry. The bytes are resolved LATE,
 * inside `open()`, so a long run never holds fifty originals open at once.
 */
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
        // "Not on this device right now" is a fact about the entry, not a
        // failure of the run — the engine collects it and carries on.
        if (error instanceof InCloudOriginalError)
          throw new TransferSourceUnavailableError(IN_CLOUD_MESSAGE);
        throw error;
      }
      // A Live Photo's paired MOV is a distinct durable upload; the canonical
      // HEIC remains the visible asset until the vault grows a compound-media
      // edge. Resolved first because the still's capture group depends on it.
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
            capturedAt: asset.capturedAt,
            // The capture's true UTC offset isn't in MediaLibrary metadata, so
            // we record none rather than fabricating the device's offset.
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
            // the companion's name comes from that file and its dimensions and
            // duration are simply not on offer.
            filename: companionFile.name,
            mediaType: "video/quicktime",
            plaintextSize: companionFile.size,
          },
          record: {
            kind: "video",
            capturedAt: asset.capturedAt,
            captureGroupId: `live:${localId}`,
          },
        });
      }
      return sends;
    },
  };
}

/** An asset with no device copy has nothing to send, so it never becomes an
 *  entry — it is not deferred, it is simply not part of this run. */
function photoEntries(
  assets: readonly PhotoAsset[],
  targetVaultId?: string
): Array<TransferEntry<PhotoRecord>> {
  return assets.flatMap((asset) =>
    asset.localId ? [photoEntry(asset, asset.localId, targetVaultId)] : []
  );
}

/**
 * The MANUAL override (§S4): a member picked these and asked for them now.
 * Unchanged in signature so the selection bar keeps working exactly as it did.
 */
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
    // Photos owns the sentence; the engine owns the reason (see transfer-run).
    ...(outcome.pausedReason
      ? { paused: `Backup paused: ${outcome.pausedReason}` }
      : {}),
  };
}

// ── The automatic path (S4) ────────────────────────────────────────────────

/**
 * THE CONSENT GATE, stated once and only once.
 *
 * `local-only` is precisely "on this device, not on the gateway" — the mobile
 * seat's danger state and the tile line beside it. Those are the photographs
 * the sweep exists for. Everything else is already somewhere safe, mid-flight,
 * or has no device copy to send.
 *
 * Pure, so the safety property is provable rather than argued: with an
 * unanswered or declined latch this returns nothing at all, and a test proves
 * that deleting the check turns red.
 */
export function automaticBackupCandidates(
  consent: BackupConsentRecord | undefined,
  assets: readonly PhotoAsset[]
): PhotoAsset[] {
  return automaticTransferPlan(
    consent,
    assets,
    // A `local-only` row with no `localId` cannot happen today (the camera-roll
    // walk is the only thing that produces the state), but a row we cannot open
    // is not a candidate however it got here.
    (asset) => asset.backupState === "local-only" && Boolean(asset.localId)
  );
}

export interface AutomaticBackupState {
  /** Photographs on this device and nowhere else, right now. Determinate. */
  remaining: number;
  /** Sources handed to the durable queue since this screen opened. Determinate:
   *  an exact number is the whole readout — there is no spinner (§18). */
  sent: number;
  /** Originals the sweep could not send because they are not on the device —
   *  iCloud-optimised stills. COUNTED AND SHOWN, never passed over in silence:
   *  a member whose library is optimised would otherwise be told everything is
   *  backed up while the originals sit in Apple's cloud. */
  deferred: number;
  running: boolean;
  /** Why the sweep is not moving, when it is not. Stated, never silent. */
  blocked?: string;
}

const POLICY_BLOCKED =
  "Waiting for a connection that matches the transfer rules below.";
const GATEWAY_BLOCKED = "Waiting for the gateway. Nothing is lost meanwhile.";

interface SweepScope {
  session: MobileReplicaSession;
  gatewayBase: string;
  vaultId?: string;
}

/**
 * ONE sweep, outside any component — the same shape the pending-queue read has
 * always had on this stack. Keeping it out here is not stylistic: an async walk
 * that reports through a callback is an EXTERNAL SYSTEM the hook synchronises
 * with, and writing it inside the component body would make every progress
 * report look like a render-time state update.
 */
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
    // A paused sweep says why; the queue keeps every row it accepted, and the
    // next timeline change (or the next foreground) resumes it.
    ...(outcome.pausedReason
      ? { blocked: `Backup paused: ${outcome.pausedReason}` }
      : {}),
  }));
}

/**
 * Drive the sweep for as long as a Photos surface is mounted.
 *
 * Deliberately NOT a background service of its own: the durable queue already
 * survives process death and `useUploadReconciliation` already re-drains on
 * every foreground, so what is missing between launches is only the ENQUEUE of
 * newly-taken photographs — and the camera-roll walk that finds them is the
 * timeline engine, which is already running wherever Photos is on screen. One
 * sweep at a time, guarded by a ref: two concurrent walks would double every
 * count and open the same original twice.
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
  // A module-scope guard would be wrong (two Photos screens are two hooks over
  // ONE queue), so the latch is per-hook and the drain lock below it is what
  // actually serialises the device. This ref only stops a hook re-entering
  // itself while its own sweep is still walking.
  const sweeping = useRef(false);
  // Memoised on the SNAPSHOT, which `useSyncExternalStore` keeps referentially
  // stable until the timeline actually changes. Without this the array is fresh
  // every render and the effect below would re-enter the sweep every render.
  const candidates = useMemo(
    () => automaticBackupCandidates(consent, timeline.assets),
    [consent, timeline.assets]
  );

  useEffect(() => {
    // Re-entered whenever the timeline's candidate set changes — which is what
    // "a photograph was just taken" looks like from here. The sweep is idle
    // when there is nothing local-only left, so this settles rather than loops.
    const start = async (): Promise<void> => {
      if (sweeping.current || candidates.length === 0) return;
      // The frame's policy, asked fresh — a sweep must not start on cellular
      // just because it was planned while the phone was on Wi-Fi.
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

  // `remaining` is derived, never stored: it is what the timeline says right
  // now, so a photograph that settles simply stops being counted.
  return { ...state, remaining: candidates.length };
}
