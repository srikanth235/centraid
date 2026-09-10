// Byte half of the first-run camera-roll import (#724): the `attempt` for
// camera-roll-import.ts's pure logic.
//
// THROUGH THE DURABLE UPLOAD QUEUE, NOT AROUND IT (#1014, R20/R8/P4).
//
// This used to POST each original's bytes straight at the gateway's staged
// import route and then publish the batch, which cost the import every
// guarantee the queue exists to give:
//
//  * NO DURABILITY. A kill, a dead radio or a backgrounded app lost the
//    in-flight photograph outright; only whole finished candidates survived,
//    in `ImportProgress`.
//  * NO `upload_item`, so the device row for an imported photograph never
//    learned its sha256 — and Photos' timeline, which joins the device roll to
//    the vault BY SHA, listed the same picture twice for ever (R8).
//  * NO VAULT ADDRESS and NO TRANSFER POLICY (P4): every original went to
//    whichever vault the gateway picked by default, over any radio, including
//    a metered one the member had told the policy table never to use.
//
// `backupDeviceMedia` is the one producer that has all three: it addresses the
// bytes once, enqueues them against the target vault, drains under
// `nativeUploadPolicy()`, and replays the canonical `photos.upload` write
// (with the device's own preview rungs attached as derivatives) only after the
// bytes carry a durable receipt. A Live Photo's paired video is a second
// durable upload under the same `live:<localId>` capture group, exactly as the
// automatic sweep does it.

import { File } from "expo-file-system";

import type { MobileReplicaSession } from "../../lib/replica/native-session";
import { gatewayCanDecode } from "../../lib/upload/gateway-decodable";
import { backupDeviceMedia } from "../../lib/upload/media-producer";
import { nativeUploadPolicy } from "../../lib/upload/native-policy";
import { runImportBatch } from "./camera-roll-import";
import type {
  ImportCandidate,
  ImportOutcome,
  ImportProgress,
} from "./camera-roll-import";
import { liveVideoUri, openDeviceOriginal } from "./device-media";

export interface ImportScope {
  gatewayBase: string;
  session: MobileReplicaSession;
  /** The vault the member is importing INTO; the queue rows carry it. */
  vaultId?: string;
}

/** Shown, not swallowed: the member asked for this and it did not happen. */
export const POLICY_BLOCKED_MESSAGE =
  "Waiting for a connection that matches your transfer rules.";

/**
 * Stage the device original through the queue; a Live Photo also queues its
 * paired video under `live:<localId>`.
 *
 * `imported` vs `skipped` is answered by the queue's own ledger, scoped to the
 * target vault (#1014, P3): bytes it has never seen for THIS vault are new,
 * whatever another vault on the same phone already holds.
 */
export async function attemptImportCandidate(
  scope: ImportScope,
  candidate: ImportCandidate
): Promise<ImportOutcome> {
  // Re-asked per candidate, as the drain does: a member who walks off Wi-Fi
  // mid-import stops shipping originals rather than finishing on cellular.
  if (!(await nativeUploadPolicy().canTransfer())) {
    throw new Error(POLICY_BLOCKED_MESSAGE);
  }
  const original = await openDeviceOriginal(candidate.localId);
  const file = new File(original.uri);
  const companion =
    candidate.kind === "photo" ? await liveVideoUri(original.asset) : null;
  const captureGroupId = companion ? `live:${candidate.localId}` : undefined;
  const target: { targetVaultId?: string } = scope.vaultId
    ? { targetVaultId: scope.vaultId }
    : {};

  let created = true;
  await backupDeviceMedia(scope.session, scope.gatewayBase, {
    localUri: original.uri,
    ...target,
    filename: candidate.filename,
    mediaType: deviceMediaType(candidate),
    onEnqueued: ({ isNew }) => {
      created = isNew;
    },
    plaintextSize: file.size,
    kind: candidate.kind,
    ...(candidate.capturedAt ? { capturedAt: candidate.capturedAt } : {}),
    ...(captureGroupId ? { captureGroupId } : {}),
    ...(candidate.width === undefined ? {} : { width: candidate.width }),
    ...(candidate.height === undefined ? {} : { height: candidate.height }),
    ...(candidate.durationS === undefined
      ? {}
      : { durationS: candidate.durationS }),
  });
  if (companion) {
    const companionFile = new File(companion);
    await backupDeviceMedia(scope.session, scope.gatewayBase, {
      localUri: companion,
      ...target,
      filename: companionFile.name,
      mediaType: "video/quicktime",
      plaintextSize: companionFile.size,
      kind: "video",
      ...(candidate.capturedAt ? { capturedAt: candidate.capturedAt } : {}),
      captureGroupId: `live:${candidate.localId}`,
    });
  }
  return created ? "imported" : "skipped";
}

/**
 * The original's OWN type, not a convenient "image/jpeg" (#1014).
 *
 * The producer decides whether to render the phone's display rungs from this,
 * and the gateway's preview codec cannot decode HEIC (`gatewayCanDecode`) — an
 * iPhone HEIC declared as a JPEG would earn the durable `preview-codec@1`
 * "unsupported" stamp with no rungs beside it, which on a real roll is most of
 * the library, never previewed and never recognised.
 */
export function deviceMediaType(
  candidate: Pick<ImportCandidate, "kind" | "filename">
): string {
  if (candidate.kind === "video") return "video/mp4";
  return gatewayCanDecode(candidate.filename) ? "image/jpeg" : "image/heic";
}

/** Bind the batch (`camera-roll-import.ts`) to this phone's real door. */
export function runImportBatchWithNudge(
  scope: ImportScope,
  candidates: readonly ImportCandidate[],
  progress: ImportProgress,
  deps: {
    nudgeSeat: () => void | Promise<unknown>;
    onProgress?: (progress: ImportProgress) => void;
  }
): Promise<ImportProgress> {
  return runImportBatch(candidates, progress, {
    attempt: (candidate) => attemptImportCandidate(scope, candidate),
    ...deps,
  });
}
